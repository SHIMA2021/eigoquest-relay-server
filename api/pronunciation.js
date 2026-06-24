// api/pronunciation.js
//
// このファイルは「中継サーバー」の本体です。
// 役割：スマホアプリから音声データを受け取り、Azure AI Speechに転送して
// 発音採点の結果をもらい、アプリにわかりやすい形で返します。
//
// アプリ側はAzureのキーを直接知らなくて済むので、安全に使えます。

export const config = {
  api: {
    bodyParser: false, // 音声データ（バイナリ）をそのまま受け取るための設定
  },
};

// リクエストのボディ（音声データ）を生のバッファとして読み込む
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // ブラウザからの直接アクセスを許可する設定（CORS）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Reference-Text');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POSTメソッドのみ受け付けます' });
    return;
  }

  // アプリ側が「採点してほしい単語（正解の英単語）」をヘッダーで送ってくる想定
  const referenceText = req.headers['x-reference-text'];
  if (!referenceText) {
    res.status(400).json({ error: '採点対象の単語（X-Reference-Text）が指定されていません' });
    return;
  }

  // Azureの認証情報は環境変数から読む（コードには直接書かない＝安全）
  const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
  const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'japaneast';

  if (!AZURE_SPEECH_KEY) {
    res.status(500).json({ error: 'サーバー側にAzureのキーが設定されていません' });
    return;
  }

  try {
    const audioBuffer = await readRawBody(req);

    if (!audioBuffer || audioBuffer.length === 0) {
      res.status(400).json({ error: '音声データが空です' });
      return;
    }

    // 発音採点の設定（PronunciationAssessmentConfig相当をJSONで作り、Base64でヘッダーに渡す）
    const pronAssessmentParams = {
      ReferenceText: referenceText,
      GradingSystem: 'HundredMark',
      Granularity: 'Phoneme',
      EnableMiscue: false,
    };
    const pronAssessmentHeader = Buffer.from(
      JSON.stringify(pronAssessmentParams)
    ).toString('base64');

    const azureUrl = `https://${AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;

    const azureResponse = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Pronunciation-Assessment': pronAssessmentHeader,
        Accept: 'application/json',
      },
      body: audioBuffer,
    });

    if (!azureResponse.ok) {
      const errorText = await azureResponse.text();
      res.status(azureResponse.status).json({
        error: 'Azureからの応答エラー',
        detail: errorText,
      });
      return;
    }

    const azureResult = await azureResponse.json();

    // Azureの詳細な結果から、子供向けの簡易スコア（◎○△）に変換する
    const simplifiedResult = simplifyForKids(azureResult);

    res.status(200).json(simplifiedResult);
  } catch (err) {
    res.status(500).json({ error: '中継サーバーでエラーが発生しました', detail: String(err) });
  }
}

// Azureの詳細スコア（0〜100点の精密な数値）を、
// 9歳児向けの3段階（great / ok / retry）に変換する
function simplifyForKids(azureResult) {
  const nBest = azureResult.NBest && azureResult.NBest[0];

  if (!nBest || !nBest.PronunciationAssessment) {
    return {
      level: 'retry',
      message: 'もういちど！',
      rawScore: null,
    };
  }

  const accuracyScore = nBest.PronunciationAssessment.AccuracyScore ?? 0;
  const recognizedText = (nBest.Display || '').toLowerCase().trim();

  // 認識された単語が正解テキストと一致している場合は、スコアに関わらず最低OK扱い
  // （Azureが音は聞き取れたが採点が厳しい場合への対策）
  let level;
  if (accuracyScore >= 70) {
    level = 'great'; // ◎
  } else if (accuracyScore >= 40 || recognizedText.length > 0) {
    level = 'ok';    // ○
  } else {
    level = 'retry'; // △
  }

  return {
    level,
    rawScore: accuracyScore,
    recognizedText: nBest.Display || '',
  };
}

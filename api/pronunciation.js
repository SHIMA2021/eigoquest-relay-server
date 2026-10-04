// api/pronunciation.js  ← v3: 発音採点デバッグ強化版
//
// 変更点：
// - Pronunciation Assessmentヘッダーを正しい形式に修正
// - fallbackの認識テキスト比較ロジックをより寛容に
// - 詳細デバッグログ追加

export const config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
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

  const referenceText = req.headers['x-reference-text'];
  if (!referenceText) {
    res.status(400).json({ error: '採点対象の単語（X-Reference-Text）が指定されていません' });
    return;
  }

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

    console.log(`[v3] referenceText="${referenceText}", audioBytes=${audioBuffer.length}`);

    // Pronunciation Assessment設定
    // 注意: EnableMiscue は boolean (true/false)、文字列ではない
    const pronAssessmentParams = {
      ReferenceText: referenceText,
      GradingSystem: 'HundredMark',
      Granularity: 'Phoneme',
      EnableMiscue: false,
    };

    // Base64エンコード（改行なし）
    const jsonStr = JSON.stringify(pronAssessmentParams);
    console.log('[v3] pronAssessmentParams:', jsonStr);

    const pronAssessmentHeader = Buffer.from(jsonStr).toString('base64').replace(/[\r\n]/g, '');
    console.log('[v3] Base64 header:', pronAssessmentHeader);

    const azureUrl = `https://${AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;

    const azureResponse = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Pronunciation-Assessment': pronAssessmentHeader,
        'Accept': 'application/json',
      },
      body: audioBuffer,
    });

    console.log('[v3] Azure HTTP status:', azureResponse.status);

    if (!azureResponse.ok) {
      const errorText = await azureResponse.text();
      console.log('[v3] Azure error:', errorText);
      res.status(azureResponse.status).json({
        error: 'Azureからの応答エラー',
        detail: errorText,
      });
      return;
    }

    const azureResult = await azureResponse.json();
    console.log('[v3] Azure full result:', JSON.stringify(azureResult));

    // 詳細デバッグ
    const nBest0 = azureResult.NBest && azureResult.NBest[0];
    console.log('[v3] RecognitionStatus:', azureResult.RecognitionStatus);
    console.log('[v3] DisplayText:', azureResult.DisplayText);
    console.log('[v3] NBest[0] keys:', nBest0 ? Object.keys(nBest0).join(',') : 'none');
    console.log('[v3] PronunciationAssessment:', JSON.stringify(nBest0?.PronunciationAssessment));

    const simplifiedResult = simplifyForKids(azureResult, referenceText);
    console.log('[v3] Final result:', JSON.stringify(simplifiedResult));

    res.status(200).json(simplifiedResult);
  } catch (err) {
    console.log('[v3] Exception:', String(err));
    res.status(500).json({ error: '中継サーバーでエラーが発生しました', detail: String(err) });
  }
}

function simplifyForKids(azureResult, referenceText) {
  const nBest = azureResult.NBest && azureResult.NBest[0];
  const recognitionStatus = azureResult.RecognitionStatus;

  // 認識テキストをクリーニング（句読点・大文字を除去）
  const recognizedText = (azureResult.DisplayText || nBest?.Display || '')
    .toLowerCase()
    .replace(/[.,!?。、]/g, '')
    .trim();

  const reference = (referenceText || '').toLowerCase().trim();

  console.log(`[v3] recognizedText="${recognizedText}", reference="${reference}", match=${recognizedText === reference}`);

  // ① PronunciationAssessmentスコアがある場合
  if (nBest && nBest.PronunciationAssessment) {
    const accuracyScore = nBest.PronunciationAssessment.AccuracyScore ?? 0;
    console.log('[v3] AccuracyScore:', accuracyScore);

    if (accuracyScore >= 70) return { level: 'great', rawScore: accuracyScore, recognizedText };
    if (accuracyScore >= 40) return { level: 'ok', rawScore: accuracyScore, recognizedText };
    // スコアが低くても認識テキストが一致なら ok
    if (recognizedText === reference) return { level: 'ok', rawScore: accuracyScore, recognizedText };
    return { level: 'retry', rawScore: accuracyScore, recognizedText };
  }

  // ② PronunciationAssessmentなし → テキスト一致で判定
  // recognitionStatus が 'Success' またはテキストが認識できていれば合格扱い
  const isSuccess = recognitionStatus === 'Success' || recognitionStatus === 'Recognized';

  if (isSuccess && recognizedText === reference) {
    // 完全一致 → great
    return { level: 'great', rawScore: null, recognizedText };
  }

  if (isSuccess && recognizedText.length > 0) {
    // 何か言えている → ok（フォールバック：とりあえず通過させる）
    return { level: 'ok', rawScore: null, recognizedText };
  }

  // 何も認識されなかった
  return { level: 'retry', rawScore: null, recognizedText };
}

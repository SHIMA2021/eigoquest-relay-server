// api/health.js
//
// このファイルは「サーバーがちゃんと動いているか」を確認するためのものです。
// デプロイ後、ブラウザで [あなたのVercel URL]/api/health にアクセスして
// {"status":"ok"} と表示されれば、サーバーは正常に動いています。

export default function handler(req, res) {
  res.status(200).json({
    status: 'ok',
    message: 'えいごクエスト中継サーバーは正常に動いています',
  });
}

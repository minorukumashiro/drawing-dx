const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const vision = require('@google-cloud/vision');
const Anthropic = require('@anthropic-ai/sdk');
const admin = require('firebase-admin');

admin.initializeApp();

const client = new vision.ImageAnnotatorClient();

// Claude APIキーはFirebaseシークレットに保管（index.htmlには絶対に置かない）
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// AI相談の利用を許可するメールアドレス（firestore.rulesの許可リストと合わせて管理すること）
const ALLOWED_EMAILS = [
  'tokyohoning@gmail.com'
];

exports.ocrV2 = onRequest({
  region: 'asia-northeast1',
  timeoutSeconds: 60,
  memory: '512MiB',
  cors: true
}, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'image is required' });
  }

  try {
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const [result] = await client.documentTextDetection({
      image: { content: base64 },
      imageContext: { languageHints: ['ja', 'en'] }
    });

    const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';
    return res.json({ text });
  } catch (error) {
    console.error('Vision API error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ========== AI相談（Claude） ==========
exports.chat = onRequest({
  region: 'asia-northeast1',
  timeoutSeconds: 120,
  memory: '512MiB',
  cors: true,
  secrets: [ANTHROPIC_API_KEY]
}, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ===== 認証: ログイン済み かつ 許可メールのみ利用可 =====
  const authz = req.headers.authorization || '';
  const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'ログインが必要です。ページを再読み込みしてログインしてください。' });
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'ログインの有効期限が切れています。再ログインしてください。' });
  }
  if (!decoded.email || !ALLOWED_EMAILS.includes(decoded.email)) {
    return res.status(403).json({ error: 'このアカウントにはAI相談の利用権限がありません。' });
  }

  const { messages, drawings, image } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
  }

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    // 全図面データをコンパクトなテキストにしてAIに渡す（RAG）
    const list = Array.isArray(drawings) ? drawings : [];
    const ctx = list.map((d, i) => {
      const num = d.number || '(図番なし)';
      const price = (d.price || d.price === 0) ? `${d.price}円` : '-';
      return `${i + 1}. ${num} | ${d.name || ''} | 材質:${d.mat || '-'} | サイズ:${d.size || '-'} | 取引先:${d.client || '-'} | 単価:${price} | 状況:${d.status || '-'}${d.cat ? ' | 分類:' + d.cat : ''}`;
    }).join('\n');

    const system = [
      {
        type: 'text',
        text: [
          'あなたは町工場（機械加工・ホーニング）向けの図面DXプラットフォームに組み込まれた、社内AIアシスタントです。',
          'ユーザーは工場の担当者です。以下の登録図面データを踏まえて、日本語で簡潔かつ実務的に答えてください。',
          '',
          'できること:',
          '・「この材質・形状の図面は過去にあるか」「似た案件はどれか」を図面データから探す',
          '・登録済みの単価を根拠に、新規図面のおおよその見積り目安を提案する',
          '・取引先ごと・材質ごと・ステータスごとの集計や傾向をまとめる',
          '・機械加工やホーニングに関する一般的な技術相談に答える',
          '・図面画像が添付された場合は、その画像から寸法・公差・面粗さ・材質・注記などを読み取って答える（読み取れない箇所は「画像から判読できません」と伝える）',
          '',
          '答え方の原則:',
          '・図面データに基づく回答では、根拠にした図番を必ず示す',
          '・データに無いことは推測せず「登録データには見当たりません」と正直に言う',
          '・単価や見積りは断定せず「あくまで目安」と明記する',
          '・箇条書きを活用し、長くなりすぎないようにする'
        ].join('\n')
      },
      {
        type: 'text',
        text: `# 登録図面データ（全${list.length}件）\n${ctx || '（まだ図面が登録されていません）'}`,
        cache_control: { type: 'ephemeral' }
      }
    ];

    const apiMessages = messages
      .filter(m => m && m.content)
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content)
      }));

    // 図面画像が添付されていれば、最後のユーザー発言に画像を付ける（Claudeが図面を読む）
    if (image && typeof image === 'string' && apiMessages.length) {
      const m = image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
      if (m) {
        const last = apiMessages[apiMessages.length - 1];
        const txt = typeof last.content === 'string' ? last.content : '';
        last.content = [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          { type: 'text', text: txt || 'この図面について答えてください。' }
        ];
      }
    }

    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system,
      messages: apiMessages
    });

    const text = resp.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return res.json({ text: text || '（回答を生成できませんでした）' });
  } catch (error) {
    console.error('Claude API error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ========== 図面フィールド自動読取り（Claude vision） ==========
// 図面/依頼書の画像から 図番・名称・材質・サイズ・得意先 等を構造化して返す。
// ocrV2(Cloud Vision＋正規表現)より精度が高く、レイアウトの複雑な図面や依頼書に強い。
exports.extractFields = onRequest({
  region: 'asia-northeast1',
  timeoutSeconds: 90,
  memory: '512MiB',
  cors: true,
  secrets: [ANTHROPIC_API_KEY]
}, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ===== 認証: ログイン済み かつ 許可メールのみ（chatと同じ） =====
  const authz = req.headers.authorization || '';
  const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'ログインが必要です。ページを再読み込みしてログインしてください。' });
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'ログインの有効期限が切れています。再ログインしてください。' });
  }
  if (!decoded.email || !ALLOWED_EMAILS.includes(decoded.email)) {
    return res.status(403).json({ error: 'このアカウントには読取り機能の利用権限がありません。' });
  }

  const { image, clients } = req.body || {};
  if (!image) {
    return res.status(400).json({ error: 'image is required' });
  }
  const im = String(image).match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (!im) {
    return res.status(400).json({ error: '画像形式が不正です（jpeg/png/webp/gif のdataURLが必要）' });
  }

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const clientList = Array.isArray(clients) ? clients.filter(Boolean).map(String).slice(0, 300) : [];

    const tool = {
      name: 'report_drawing_fields',
      description: '図面または依頼書から読み取った各フィールドを報告する。読み取れない項目は必ず空文字にする。',
      input_schema: {
        type: 'object',
        properties: {
          number:   { type: 'string', description: '図番/図面番号/管理番号（表題欄のDWG.NO・図面番号・不二新等の管理番号）。無ければ空文字。' },
          name:     { type: 'string', description: '品名/名称/TITLE（部品の名前）。無ければ空文字。' },
          material: { type: 'string', description: '材質（例 SUS304, S45C, A5052, SCM435, STKM13C, 64チタン）。無ければ空文字。' },
          size:     { type: 'string', description: 'サイズ。内径ホーニング加工の丸物なら「φ内径-全長」形式（例 φ65-163, φ115-487）。それ以外は図面の主要寸法表記（例 φ80×t12）。無ければ空文字。' },
          client:   { type: 'string', description: '得意先/発注元の会社名。図面や依頼書にレターヘッド・社名・ロゴがある場合のみ記入。FAX番号やメール送信元は画像に写っていないので、社名が図中に無ければ必ず空文字。絶対に推測しないこと。' },
          surface:  { type: 'string', description: '表面処理（メッキ/めっき/アルマイト/無電解ニッケル/硬質クロム等）。無ければ空文字。' },
          tolerance:{ type: 'string', description: '代表的な公差（例 +0.02〜+0.05, ±0.1）。無ければ空文字。' },
          roughness:{ type: 'string', description: '表面粗さ（例 Ra0.2, Rz0.8, 1.6S, ▽▽▽▽）。無ければ空文字。' },
          quantity: { type: 'string', description: '数量（本数・個数）。無ければ空文字。' },
          category: { type: 'string', description: 'フランジ / シャフト / ブラケット / プレート / スペーサー / その他 のいずれか。判断できなければ空文字。' },
          note:     { type: 'string', description: '見積・加工上重要な注記があれば一言（例「トンボ加工不可」「内径メッキ後ホーニング」）。無ければ空文字。' }
        },
        required: ['number', 'name', 'material', 'size', 'client']
      }
    };

    const system = [
      'あなたは町工場（機械加工・内径ホーニング）の図面DXに組み込まれた読取りアシスタントです。',
      '与えられた図面または表形式の依頼書の画像を読み、report_drawing_fields ツールで各フィールドを報告してください。',
      '',
      '重要な原則:',
      '・読み取れない項目は推測せず必ず空文字にする。',
      '・ホーニングは内径加工なので、丸物パイプ/シリンダは内径と全長を優先し size は「φ内径-全長」形式にする（例 内径φ65・全長163 → φ65-163）。',
      '・得意先は、図面/依頼書の中に社名・レターヘッド・会社ロゴが実際に書かれている場合だけ記入する。書かれていなければ空文字（FAX番号やメール送信元は画像に無いため判定不可）。',
      '・材質・図番・数量は表題欄や依頼書の該当欄を正確に写す。数字の桁（0.02と0.2など）を間違えない。',
      clientList.length ? ('\n既存の得意先名（社名がこれらに近ければ、この表記に正規化して返す）:\n' + clientList.join(' / ')) : ''
    ].join('\n');

    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'report_drawing_fields' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: im[1], data: im[2] } },
          { type: 'text', text: 'この図面（または依頼書）から各フィールドを読み取り、report_drawing_fields で報告してください。' }
        ]
      }]
    });

    const tu = resp.content.find(b => b.type === 'tool_use');
    const fields = (tu && tu.input) ? tu.input : {};
    return res.json({ fields });
  } catch (error) {
    console.error('extractFields error:', error);
    return res.status(500).json({ error: error.message });
  }
});

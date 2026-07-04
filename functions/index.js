const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const vision = require('@google-cloud/vision');
const Anthropic = require('@anthropic-ai/sdk');

const client = new vision.ImageAnnotatorClient();

// Claude APIキーはFirebaseシークレットに保管（index.htmlには絶対に置かない）
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

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

  const { messages, drawings } = req.body || {};
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

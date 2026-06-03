const { onRequest } = require('firebase-functions/v2/https');
const vision = require('@google-cloud/vision');

const client = new vision.ImageAnnotatorClient();

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

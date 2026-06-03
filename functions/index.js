const { onCall, HttpsError } = require('firebase-functions/v2/https');
const vision = require('@google-cloud/vision');

const client = new vision.ImageAnnotatorClient();

exports.ocrDrawing = onCall({
  region: 'asia-northeast1',
  timeoutSeconds: 60,
  memory: '512MiB'
}, async (request) => {
  if (!request.data.image) {
    throw new HttpsError('invalid-argument', 'image is required');
  }

  const base64 = request.data.image.replace(/^data:image\/\w+;base64,/, '');

  const [result] = await client.textDetection({
    image: { content: base64 }
  });

  const text = result.fullTextAnnotation ? result.fullTextAnnotation.text : '';
  return { text };
});

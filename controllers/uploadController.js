const { Storage } = require('@google-cloud/storage');
const path = require('path');

// This connects to your Google Cloud using the key we downloaded
const storage = new Storage({
  keyFilename: path.join(__dirname, '../gcp-key.json') 
});
const bucket = storage.bucket('watchaugs-mitra-public-content');

exports.handleUpload = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const cleanName = req.file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
  const folder = cleanName.endsWith('.glb') || cleanName.endsWith('.usdz') ? 'ar-models/' : 'topic-images/';
  const destinationPath = `${folder}${Date.now()}_${cleanName}`;
  const blob = bucket.file(destinationPath);

  const blobStream = blob.createWriteStream({
    resumable: false,
    contentType: req.file.mimetype,
  });

  blobStream.on('finish', () => {
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
    res.status(200).json({ success: true, url: publicUrl });
  });

  blobStream.end(req.file.buffer);
};
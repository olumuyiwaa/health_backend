const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const s3Client = new S3Client({
    endpoint:        process.env.DO_SPACES_ENDPOINT,
    region:          process.env.DO_SPACES_REGION,
    credentials: {
        accessKeyId:     process.env.DO_SPACES_KEY,
        secretAccessKey: process.env.DO_SPACES_SECRET,
    },
    forcePathStyle:  false,
});

const BUCKET = process.env.DO_SPACES_BUCKET;

const ALLOWED_MIME_TYPES = {
    documents: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    images:    ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    all:       ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'],
};

// Build a scoped upload middleware for a given folder prefix
function createUploader({ folder = 'uploads', allowedTypes = 'documents', maxSizeMB = 10 } = {}) {
    return multer({
        storage: multerS3({
            s3:      s3Client,
            bucket:  BUCKET,
            acl:     'private',                   // No public access
            key: (req, file, cb) => {
                const ext = path.extname(file.originalname).toLowerCase();
                const key = `${folder}/${uuidv4()}${ext}`;
                cb(null, key);
            },
            contentType: multerS3.AUTO_CONTENT_TYPE,
            metadata: (req, file, cb) => {
                cb(null, { fieldName: file.fieldname, uploadedBy: req.user?.id || 'anonymous' });
            },
        }),
        limits: { fileSize: maxSizeMB * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const allowed = ALLOWED_MIME_TYPES[allowedTypes] || ALLOWED_MIME_TYPES.all;
            if (allowed.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error(`File type not allowed. Accepted: ${allowed.join(', ')}`), false);
            }
        },
    });
}

// Generate a time-limited signed URL for private object access
async function getPrivateUrl(key, expiresInSeconds = Number(process.env.SIGNED_URL_EXPIRY) || 3600) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

// Delete an object from Spaces
async function deleteObject(key) {
    const command = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
    return s3Client.send(command);
}

module.exports = { s3Client, createUploader, getPrivateUrl, deleteObject, BUCKET };
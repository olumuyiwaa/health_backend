const router = require('express').Router();
const { body, query } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { uploadRateLimiter } = require('../../middleware/rateLimiter');
const { createUploader, getPrivateUrl, deleteObject, s3Client, BUCKET } = require('../../config/storage');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { successResponse, createdResponse, errorResponse } = require('../../utils/response');
const { writeAuditLog } = require('../../utils/audit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Allowed folder → role map: defines which roles can upload to which folders
const FOLDER_POLICY = {
    'credentials':       ['NURSE'],
    'facility-logos':    ['SUPER_ADMIN', 'FACILITY_ADMIN'],
    'facility-documents':['SUPER_ADMIN', 'FACILITY_ADMIN', 'TEAM_MEMBER'],
    'avatars':           ['NURSE', 'FACILITY_ADMIN', 'TEAM_MEMBER', 'SUPER_ADMIN', 'RECRUITER'],
    'chat-attachments':  ['NURSE', 'FACILITY_ADMIN', 'TEAM_MEMBER', 'SUPER_ADMIN', 'RECRUITER'],
    'visit-signatures':  ['NURSE'],
    'admin-documents':   ['SUPER_ADMIN'],
};

const ALLOWED_EXTENSIONS = {
    'credentials':        ['.pdf', '.jpg', '.jpeg', '.png', '.webp'],
    'facility-logos':     ['.jpg', '.jpeg', '.png', '.webp', '.svg'],
    'facility-documents': ['.pdf', '.jpg', '.jpeg', '.png'],
    'avatars':            ['.jpg', '.jpeg', '.png', '.webp'],
    'chat-attachments':   ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov'],
    'visit-signatures':   ['.png', '.jpg', '.jpeg'],
    'admin-documents':    ['.pdf', '.docx', '.xlsx', '.csv'],
};

const MAX_SIZE_MB = {
    'credentials':        15,
    'facility-logos':     5,
    'facility-documents': 20,
    'avatars':            5,
    'chat-attachments':   50,
    'visit-signatures':   5,
    'admin-documents':    50,
};

// ─── POST /storage/signed-upload-url ──────────
// Request a pre-signed PUT URL for direct-to-Spaces upload from the client.
// Preferred for large files — avoids routing through the API server.
router.post('/signed-upload-url',
    authenticate,
    uploadRateLimiter,
    [
        body('folder').notEmpty().isIn(Object.keys(FOLDER_POLICY)),
        body('filename').trim().notEmpty(),
        body('contentType').trim().notEmpty(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const { folder, filename, contentType } = req.body;

            // Role check
            const allowed = FOLDER_POLICY[folder];
            if (!allowed.includes(req.user.role)) {
                return errorResponse(res, `You are not permitted to upload to the "${folder}" folder`, 403);
            }

            // Extension check
            const ext = path.extname(filename).toLowerCase();
            const allowedExts = ALLOWED_EXTENSIONS[folder];
            if (!allowedExts.includes(ext)) {
                return errorResponse(
                    res,
                    `File type "${ext}" is not allowed for "${folder}". Allowed: ${allowedExts.join(', ')}`,
                    415,
                );
            }

            // Max size is enforced on the signed URL via ContentLengthRange condition
            const maxBytes = (MAX_SIZE_MB[folder] || 10) * 1024 * 1024;

            const objectKey = `${folder}/${uuidv4()}${ext}`;

            const command = new PutObjectCommand({
                Bucket:      BUCKET,
                Key:         objectKey,
                ContentType: contentType,
                ACL:         'private',
                Metadata: {
                    uploadedBy: req.user.id,
                    folder,
                    originalFilename: encodeURIComponent(filename),
                },
            });

            const signedUrl = await getSignedUrl(s3Client, command, {
                expiresIn: 300, // 5 minutes to begin upload
            });

            await writeAuditLog({
                userId:     req.user.id,
                action:     'UPLOAD',
                resource:   'Storage',
                resourceId: objectKey,
                newData:    { folder, filename, contentType },
                req,
            });

            return createdResponse(res, {
                uploadUrl:   signedUrl,
                objectKey,
                expiresIn:   300,
                maxBytes,
                // Client must call /storage/confirm after successful upload
                confirmUrl:  `/api/v1/storage/confirm`,
            }, 'Signed upload URL generated');
        } catch (err) { next(err); }
    }
);

// ─── POST /storage/confirm ────────────────────
// Called by the client after a successful direct-to-Spaces upload.
// Returns a short-lived signed download URL so the client can verify the file.
router.post('/confirm',
    authenticate,
    [body('objectKey').trim().notEmpty()],
    validate,
    async (req, res, next) => {
        try {
            const { objectKey } = req.body;

            // Key must start with a folder this user is allowed to write
            const folder = objectKey.split('/')[0];
            const allowed = FOLDER_POLICY[folder];

            if (!allowed || !allowed.includes(req.user.role)) {
                return errorResponse(res, 'Object key references a restricted folder', 403);
            }

            const downloadUrl = await getPrivateUrl(objectKey, 3600);

            return successResponse(res, {
                objectKey,
                downloadUrl,
                expiresIn: 3600,
            }, 'Upload confirmed');
        } catch (err) { next(err); }
    }
);

// ─── POST /storage/upload/:folder ─────────────
// Multipart upload proxied through the API server.
// Use for smaller files (credentials, avatars, signatures) where
// direct-to-Spaces is not needed.
router.post('/upload/:folder',
    authenticate,
    uploadRateLimiter,
    (req, res, next) => {
        const folder = req.params.folder;

        // Role check before handing off to multer
        const allowed = FOLDER_POLICY[folder];
        if (!allowed) return errorResponse(res, 'Unknown storage folder', 400);
        if (!allowed.includes(req.user.role)) return errorResponse(res, 'Forbidden', 403);

        const maxMB = MAX_SIZE_MB[folder] || 10;
        const uploader = createUploader({ folder, maxSizeMB: maxMB });

        uploader.single('file')(req, res, (err) => {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return errorResponse(res, `File exceeds the ${maxMB}MB limit for this folder`, 413);
                }
                return next(err);
            }
            next();
        });
    },
    async (req, res, next) => {
        try {
            const folder = req.params.folder;

            if (!req.file) return errorResponse(res, 'No file received', 400);

            const ext = path.extname(req.file.originalname).toLowerCase();
            const allowedExts = ALLOWED_EXTENSIONS[folder];
            if (allowedExts && !allowedExts.includes(ext)) {
                // File was already uploaded by multer-s3; delete it before rejecting
                await deleteObject(req.file.key).catch(() => {});
                return errorResponse(res, `File type "${ext}" not allowed in "${folder}"`, 415);
            }

            const downloadUrl = await getPrivateUrl(req.file.key);

            await writeAuditLog({
                userId:     req.user.id,
                action:     'UPLOAD',
                resource:   'Storage',
                resourceId: req.file.key,
                newData:    { folder, originalName: req.file.originalname, size: req.file.size },
                req,
            });

            return createdResponse(res, {
                objectKey:    req.file.key,
                originalName: req.file.originalname,
                size:         req.file.size,
                mimeType:     req.file.mimetype,
                downloadUrl,
                expiresIn:    Number(process.env.SIGNED_URL_EXPIRY) || 3600,
            }, 'File uploaded successfully');
        } catch (err) { next(err); }
    }
);

// ─── GET /storage/download ────────────────────
// Generate a fresh signed download URL for any private object.
router.get('/download',
    authenticate,
    [query('key').trim().notEmpty()],
    validate,
    async (req, res, next) => {
        try {
            const { key } = req.query;
            const folder  = key.split('/')[0];

            // Nurses may only download from their own credential folder
            // (other roles get broader access — refine per business rules)
            if (req.user.role === 'NURSE' && !['credentials', 'avatars', 'visit-signatures', 'chat-attachments'].includes(folder)) {
                return errorResponse(res, 'Forbidden', 403);
            }

            const expiresIn  = Number(req.query.expiresIn) || Number(process.env.SIGNED_URL_EXPIRY) || 3600;
            const downloadUrl = await getPrivateUrl(key, Math.min(expiresIn, 86400)); // cap at 24h

            return successResponse(res, { objectKey: key, downloadUrl, expiresIn });
        } catch (err) { next(err); }
    }
);

// ─── DELETE /storage ──────────────────────────
// Hard-delete an object from Spaces.
// Admins only — individual resource deletions go through their own modules.
router.delete('/',
    authenticate,
    authorize('SUPER_ADMIN'),
    [body('key').trim().notEmpty()],
    validate,
    async (req, res, next) => {
        try {
            const { key } = req.body;

            await deleteObject(key);

            await writeAuditLog({
                userId:     req.user.id,
                action:     'DELETE',
                resource:   'Storage',
                resourceId: key,
                req,
            });

            return successResponse(res, { objectKey: key }, 'Object deleted');
        } catch (err) { next(err); }
    }
);

// ─── GET /storage/folders ─────────────────────
// List the folders (prefixes) this user is allowed to upload to.
router.get('/folders', authenticate, (req, res) => {
    const accessible = Object.entries(FOLDER_POLICY)
        .filter(([, roles]) => roles.includes(req.user.role))
        .map(([folder]) => ({
            folder,
            allowedExtensions: ALLOWED_EXTENSIONS[folder],
            maxSizeMB:         MAX_SIZE_MB[folder],
        }));

    return successResponse(res, accessible);
});

module.exports = router;

function successResponse(res, data = {}, message = 'Success', statusCode = 200) {
    // return res.status(statusCode).json({ success: true, message, data });
    // Convert any BigInts in the payload
    const sanitized = JSON.parse(JSON.stringify(data, (key, value) =>
        typeof value === 'bigint' ? Number(value) : value
    ));
    return res.status(status).json(sanitized);
}

function createdResponse(res, data = {}, message = 'Created successfully') {
    return res.status(201).json({ success: true, message, data });
}

function paginatedResponse(res, data, pagination, message = 'Success') {
    return res.status(200).json({ success: true, message, data, pagination });
}

function errorResponse(res, message = 'An error occurred', statusCode = 400, errors = null) {
    const body = { success: false, message };
    if (errors) body.errors = errors;
    return res.status(statusCode).json(body);
}

function buildPagination(page, limit, total) {
    const totalPages = Math.ceil(total / limit);
    return {
        page:       Number(page),
        limit:      Number(limit),
        total,
        totalPages,
        hasNext:    page < totalPages,
        hasPrev:    page > 1,
    };
}

module.exports = { successResponse, createdResponse, paginatedResponse, errorResponse, buildPagination };// src/utils/response.js

function successResponse(res, data = {}, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json({ success: true, message, data });
}

function createdResponse(res, data = {}, message = 'Created successfully') {
    return res.status(201).json({ success: true, message, data });
}

function paginatedResponse(res, data, pagination, message = 'Success') {
    return res.status(200).json({ success: true, message, data, pagination });
}

function errorResponse(res, message = 'An error occurred', statusCode = 400, errors = null) {
    const body = { success: false, message };
    if (errors) body.errors = errors;
    return res.status(statusCode).json(body);
}

function buildPagination(page, limit, total) {
    const totalPages = Math.ceil(total / limit);
    return {
        page:       Number(page),
        limit:      Number(limit),
        total,
        totalPages,
        hasNext:    page < totalPages,
        hasPrev:    page > 1,
    };
}

module.exports = { successResponse, createdResponse, paginatedResponse, errorResponse, buildPagination };
const swaggerUi = require('swagger-ui-express');
const YAML = require('js-yaml');
const fs   = require('fs');
const path = require('path');

function setupSwagger(app) {
  const specPath = path.join(__dirname, '../../docs/openapi.yaml');

  let spec;
  try {
    spec = YAML.load(fs.readFileSync(specPath, 'utf8'));
  } catch (err) {
    console.error('Failed to load OpenAPI spec:', err.message);
    return;
  }

  const swaggerOptions = {
    customSiteTitle: 'Healthcare Staffing API Docs',
    customCss: `
      .swagger-ui .topbar { background-color: #0f2942; }
      .swagger-ui .topbar-wrapper img { content: none; }
      .swagger-ui .topbar-wrapper::after {
        content: 'Healthcare Staffing Platform';
        color: #d4a843;
        font-size: 18px;
        font-weight: 700;
        letter-spacing: 0.5px;
      }
      .swagger-ui .info .title { color: #0f2942; }
      .swagger-ui .btn.authorize { background-color: #0f2942; border-color: #0f2942; }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: process.env.NODE_ENV !== 'production',
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      defaultModelsExpandDepth: 1,
      docExpansion: 'none',
    },
  };

  // Serve interactive UI at /api-docs
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, swaggerOptions),
  );

  // Serve raw spec as JSON at /api-docs/spec.json
  app.get('/api-docs/spec.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(spec);
  });

  // Serve raw spec as YAML at /api-docs/spec.yaml
  app.get('/api-docs/spec.yaml', (req, res) => {
    res.setHeader('Content-Type', 'text/yaml');
    res.send(fs.readFileSync(specPath, 'utf8'));
  });

  console.log('📚 Swagger UI available at /api-docs');
}

module.exports = { setupSwagger };
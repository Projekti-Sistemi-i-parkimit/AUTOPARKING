"use strict";

// Specifikimi OpenAPI 3.0 — shërbehet te /api/openapi.json dhe vizualizohet
// me Swagger UI te /api/docs.

const paginatedOf = (itemRef) => ({
  type: "object",
  properties: {
    data: { type: "array", items: itemRef },
    page: { type: "integer" },
    limit: { type: "integer" },
    total: { type: "integer" },
    total_pages: { type: "integer" },
  },
});

const errorResponse = (description) => ({
  description,
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
  },
});

const pageParams = [
  { name: "page", in: "query", schema: { type: "integer", minimum: 1 }, description: "Faqja (default 1)" },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 }, description: "Elemente për faqe (default 50)" },
];

module.exports = {
  openapi: "3.0.3",
  info: {
    title: "Parkimi Inteligjent — Backend API",
    version: "1.0.0",
    description:
      "REST API për sistemin e monitorimit dhe menaxhimit të parkimit. " +
      "Ura e Arduino-s autentikohet me header `x-api-key`; administratorët me `Authorization: Bearer <token>`.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "Vendet", description: "Vendet e parkimit dhe gjendja e tyre" },
    { name: "Sensorët" },
    { name: "Ngjarjet", description: "Hyrje/dalje dhe barriera" },
    { name: "QR" },
    { name: "Vizitorët", description: "Hyrja dhe rezervimet e vizitorëve" },
    { name: "Ura", description: "Dërgimi i të dhënave nga ura e Arduino-s (x-api-key)" },
    { name: "Admin", description: "Autentikimi dhe administrimi (Bearer token, RBAC)" },
    { name: "Në kohë reale" },
  ],
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      bearer: { type: "http", scheme: "bearer" },
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
      Spot: {
        type: "object",
        properties: {
          spot_key: { type: "string", example: "A-P1" },
          sector: { type: "string", example: "A" },
          label: { type: "string", example: "P1" },
          has_sensor: { type: "integer" },
          status: { type: "string", enum: ["free", "occupied", "unknown"] },
          distance_cm: { type: "number", nullable: true },
          updated_at: { type: "string" },
        },
      },
      Reading: {
        type: "object",
        properties: {
          distance_cm: { type: "number", nullable: true },
          status: { type: "string", enum: ["free", "occupied", "unknown"] },
          sensor_ok: { type: "integer" },
          created_at: { type: "string" },
        },
      },
      GateEvent: {
        type: "object",
        properties: {
          id: { type: "integer" },
          type: { type: "string", enum: ["entry", "exit"] },
          plate: { type: "string", nullable: true },
          source: { type: "string" },
          created_at: { type: "string" },
        },
      },
      BarrierEvent: {
        type: "object",
        properties: {
          id: { type: "integer" },
          status: { type: "string", enum: ["open", "closed", "error"] },
          reason: { type: "string", nullable: true },
          source: { type: "string" },
          created_at: { type: "string" },
        },
      },
      Stats: {
        type: "object",
        properties: {
          sector: { type: "string" },
          total: { type: "integer" },
          free: { type: "integer" },
          occupied: { type: "integer" },
          unknown: { type: "integer" },
          reserved: { type: "integer" },
          occupancy_pct: { type: "integer" },
        },
      },
    },
  },
  paths: {
    "/api/health": {
      get: { tags: ["Vendet"], summary: "Kontrolli i shëndetit", responses: { 200: { description: "OK" } } },
    },
    "/api/spots": {
      get: {
        tags: ["Vendet"],
        summary: "Lista e vendeve (me filtrim dhe faqëzim)",
        parameters: [
          { name: "sector", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["free", "occupied", "unknown"] } },
          ...pageParams,
        ],
        responses: {
          200: {
            description: "Lista e faqëzuar",
            content: { "application/json": { schema: paginatedOf({ $ref: "#/components/schemas/Spot" }) } },
          },
          400: errorResponse("Parametra të pavlefshëm"),
        },
      },
    },
    "/api/spots/{key}": {
      get: {
        tags: ["Vendet"],
        summary: "Detajet e një vendi (gjendja, rezervimi, qëndrimi aktiv)",
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" }, example: "A-P1" }],
        responses: { 200: { description: "Detajet" }, 404: errorResponse("Vendi nuk ekziston") },
      },
    },
    "/api/spots/{key}/readings": {
      get: {
        tags: ["Sensorët"],
        summary: "Historiku i matjeve të një vendi",
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }, ...pageParams],
        responses: {
          200: {
            description: "Matjet e faqëzuara",
            content: { "application/json": { schema: paginatedOf({ $ref: "#/components/schemas/Reading" }) } },
          },
          404: errorResponse("Vendi nuk ekziston"),
        },
      },
    },
    "/api/sensors": {
      get: { tags: ["Sensorët"], summary: "Gjendja e sensorëve (matja e fundit për çdo vend me sensor)", responses: { 200: { description: "Lista" } } },
    },
    "/api/stats": {
      get: {
        tags: ["Vendet"],
        summary: "Statistikat e zënies",
        parameters: [{ name: "sector", in: "query", schema: { type: "string" } }],
        responses: { 200: { description: "Statistikat", content: { "application/json": { schema: { $ref: "#/components/schemas/Stats" } } } } },
      },
    },
    "/api/state": {
      get: { tags: ["Vendet"], summary: "Fotografia e plotë e gjendjes (formati i frontend-it)", responses: { 200: { description: "Gjendja" } } },
    },
    "/api/events": {
      get: {
        tags: ["Ngjarjet"],
        summary: "Ngjarjet e hyrjes/daljes",
        parameters: [{ name: "type", in: "query", schema: { type: "string", enum: ["entry", "exit"] } }, ...pageParams],
        responses: { 200: { description: "Lista e faqëzuar", content: { "application/json": { schema: paginatedOf({ $ref: "#/components/schemas/GateEvent" }) } } } },
      },
      post: {
        tags: ["Ura"],
        summary: "Regjistron ngjarje hyrjeje/daljeje (nga ura)",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["type"],
                properties: { type: { type: "string", enum: ["entry", "exit"] }, plate: { type: "string" } },
              },
            },
          },
        },
        responses: { 201: { description: "U regjistrua" }, 400: errorResponse("Kërkesë e pavlefshme"), 401: errorResponse("Çelës API i pavlefshëm") },
      },
    },
    "/api/barrier": {
      get: { tags: ["Ngjarjet"], summary: "Gjendja aktuale e barrierës", responses: { 200: { description: "Gjendja" } } },
      post: {
        tags: ["Ura"],
        summary: "Përditëson gjendjen e barrierës (nga ura)",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status"],
                properties: { status: { type: "string", enum: ["open", "closed", "error"] }, reason: { type: "string" } },
              },
            },
          },
        },
        responses: { 200: { description: "U përditësua" }, 400: errorResponse("Kërkesë e pavlefshme"), 401: errorResponse("Çelës API i pavlefshëm") },
      },
    },
    "/api/barrier/events": {
      get: {
        tags: ["Ngjarjet"],
        summary: "Historiku i ngjarjeve të barrierës",
        parameters: pageParams,
        responses: { 200: { description: "Lista e faqëzuar", content: { "application/json": { schema: paginatedOf({ $ref: "#/components/schemas/BarrierEvent" }) } } } },
      },
    },
    "/api/sensor": {
      post: {
        tags: ["Ura"],
        summary: "Dërgon matjet/gjendjet e sensorëve (nga ura e Arduino-s)",
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["spots"],
                properties: {
                  spots: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["key"],
                      properties: {
                        key: { type: "string", example: "A-P1" },
                        cm: { type: "number", nullable: true },
                        sensor_ok: { type: "boolean" },
                        status: { type: "string", enum: ["free", "occupied", "unknown"], description: "Opsionale — nëse mungon, llogaritet nga distanca" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { 200: { description: "U zbatuan matjet" }, 400: errorResponse("Kërkesë e pavlefshme"), 401: errorResponse("Çelës API i pavlefshëm") },
      },
    },
    "/api/qr/{key}": {
      get: {
        tags: ["QR"],
        summary: "Informacioni i QR-së për një vend",
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "Informacioni" }, 404: errorResponse("Vendi nuk ekziston") },
      },
    },
    "/api/qr/scan": {
      post: {
        tags: ["QR"],
        summary: "Regjistron skanimin e QR-së (ku parkoi vetura)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["code", "plate"], properties: { code: { type: "string" }, plate: { type: "string" } } },
            },
          },
        },
        responses: { 201: { description: "U regjistrua" }, 404: errorResponse("Kodi nuk njihet") },
      },
    },
    "/api/qr/find": {
      get: {
        tags: ["QR"],
        summary: "Gjeje veturën time — vendi i fundit i skanuar për një targë",
        parameters: [{ name: "plate", in: "query", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "Vendi" }, 404: errorResponse("Asnjë skanim") },
      },
    },
    "/api/login": {
      post: {
        tags: ["Vizitorët"],
        summary: "Hyrja e vizitorit (emër + targë) → token",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["name", "plate"], properties: { name: { type: "string" }, plate: { type: "string" } } },
            },
          },
        },
        responses: { 201: { description: "Token-i i vizitorit" }, 400: errorResponse("Kërkesë e pavlefshme") },
      },
    },
    "/api/reserve": {
      post: {
        tags: ["Vizitorët"],
        summary: "Rezervon një vend",
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["key", "end"], properties: { key: { type: "string" }, end: { type: "integer", description: "epoch ms" } } },
            },
          },
        },
        responses: { 201: { description: "U rezervua" }, 401: errorResponse("Pa token"), 409: errorResponse("I zënë ose i rezervuar") },
      },
    },
    "/api/reserve/{key}": {
      delete: {
        tags: ["Vizitorët"],
        summary: "Anulon rezervimin e vet",
        security: [{ bearer: [] }],
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "U anulua" }, 403: errorResponse("Jo rezervimi juaj"), 404: errorResponse("Nuk ka rezervim") },
      },
    },
    "/api/realtime": {
      get: {
        tags: ["Në kohë reale"],
        summary: "Rrjedha SSE e përditësimeve në kohë reale",
        description:
          "Server-Sent Events. Ngjarjet: `spot_update`, `stats`, `gate_event`, `barrier_update`, `reservation`, `qr_scan`. " +
          "Përdor `new EventSource('/api/realtime')` në frontend; rilidhja bëhet automatikisht.",
        responses: { 200: { description: "Rrjedha text/event-stream" } },
      },
    },
    "/api/admin/login": {
      post: {
        tags: ["Admin"],
        summary: "Hyrja e administratorit",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["username", "password"], properties: { username: { type: "string" }, password: { type: "string" } } },
            },
          },
        },
        responses: { 200: { description: "Token + roli" }, 401: errorResponse("Kredenciale të gabuara") },
      },
    },
    "/api/admin/logout": {
      post: { tags: ["Admin"], summary: "Dalja (fshin sesionin)", security: [{ bearer: [] }], responses: { 200: { description: "OK" }, 401: errorResponse("Pa token") } },
    },
    "/api/admin/me": {
      get: { tags: ["Admin"], summary: "Profili i adminit të kyçur", security: [{ bearer: [] }], responses: { 200: { description: "Profili" }, 401: errorResponse("Pa token") } },
    },
    "/api/admin/users": {
      get: { tags: ["Admin"], summary: "Lista e administratorëve (vetëm roli admin)", security: [{ bearer: [] }], responses: { 200: { description: "Lista" }, 403: errorResponse("Pa të drejta") } },
      post: {
        tags: ["Admin"],
        summary: "Krijon administrator/operator të ri (vetëm roli admin)",
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "password"],
                properties: { username: { type: "string" }, password: { type: "string", minLength: 8 }, role: { type: "string", enum: ["admin", "operator"] } },
              },
            },
          },
        },
        responses: { 201: { description: "U krijua" }, 409: errorResponse("Ekziston") },
      },
    },
    "/api/admin/api-keys": {
      get: { tags: ["Admin"], summary: "Lista e çelësave API (pa hash-e)", security: [{ bearer: [] }], responses: { 200: { description: "Lista" } } },
      post: {
        tags: ["Admin"],
        summary: "Krijon çelës API — vlera e plotë kthehet VETËM një herë",
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, expires_at: { type: "string", format: "date-time" } } },
            },
          },
        },
        responses: { 201: { description: "Çelësi i ri" } },
      },
    },
    "/api/admin/api-keys/{id}": {
      delete: {
        tags: ["Admin"],
        summary: "Çaktivizon një çelës API",
        security: [{ bearer: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { 200: { description: "U çaktivizua" }, 404: errorResponse("Nuk u gjet") },
      },
    },
    "/api/admin/audit-log": {
      get: {
        tags: ["Admin"],
        summary: "Audit log-u i veprimeve administrative",
        security: [{ bearer: [] }],
        parameters: pageParams,
        responses: { 200: { description: "Lista e faqëzuar" } },
      },
    },
  },
};
// Shared Gemini (Vertex AI) client using Application Default Credentials.
//
// Every Gemini call in the backend goes through this module, so authentication, timeouts, retries
// and error messages are handled in one place. No API keys are used: credentials come from ADC
// (`gcloud auth application-default login`, GOOGLE_APPLICATION_CREDENTIALS, or an attached
// service account). Nothing here is ever sent to the frontend except safe, explanatory messages.

import { GoogleGenAI, ApiError } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";

import * as config from "../config.js";
import { getLogger, perf } from "../util.js";

const logger = getLogger("app.services.gemini");

export const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
const RETRY = { attempts: 4, initialDelay: 2.0, maxDelay: 30.0, httpStatusCodes: [429, 500, 502, 503, 504] };

/** Gemini cannot be reached or refused the request. The message is safe to show to users. */
export class GeminiUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "GeminiUnavailable";
  }
}

const NO_CREDENTIALS =
  "Google Cloud credentials were not found. Run `gcloud auth application-default login` " +
  "(local development) or set GOOGLE_APPLICATION_CREDENTIALS / attach the " +
  "gemini-app-backend service account, then restart the backend.";

let clientPromise = null;
let testClient = null;

/** Replace the client (tests only); pass null to restore normal behaviour. */
export function setClientForTests(client) {
  testClient = client;
  clientPromise = null;
}

/** Overridable ADC loader (tests simulate a machine without credentials). */
export const adc = {
  async load() {
    const auth = new GoogleAuth({ scopes: SCOPES });
    let client;
    try {
      client = await auth.getClient();
    } catch (exc) {
      throw Object.assign(new GeminiUnavailable(NO_CREDENTIALS), { cause: exc });
    }
    let projectId = null;
    try {
      projectId = await auth.getProjectId();
    } catch {
      projectId = null;
    }
    let serviceAccount = null;
    try {
      serviceAccount = (await auth.getCredentials()).client_email ?? null;
    } catch {
      serviceAccount = null;
    }
    return { auth, client, projectId, serviceAccount };
  },
};

/** Lazily build one shared genai client. */
export async function getClient() {
  if (testClient) return testClient;
  if (!clientPromise) {
    clientPromise = (async () => {
      const { projectId } = await adc.load();
      const project = config.GOOGLE_CLOUD_PROJECT || projectId;
      if (!project) throw new GeminiUnavailable("GOOGLE_CLOUD_PROJECT is not set in backend/.env.");
      const client = new GoogleGenAI({
        enterprise: true,
        project,
        location: config.GOOGLE_CLOUD_LOCATION,
        googleAuthOptions: { scopes: SCOPES },
        httpOptions: { timeout: config.settings.GEMINI_TIMEOUT_SECONDS * 1000, retryOptions: RETRY },
      });
      logger.info(`Gemini client ready (project=${project}, location=${config.GOOGLE_CLOUD_LOCATION})`);
      return client;
    })();
    clientPromise.catch(() => {
      clientPromise = null; // retry credential loading on the next call, like the previous backend
    });
  }
  return clientPromise;
}

function parseApiError(exc) {
  // ApiError.message carries the JSON error body from Vertex AI.
  let message = exc.message ?? "";
  let details = message;
  try {
    const body = JSON.parse(message.slice(message.indexOf("{")));
    const err = Array.isArray(body) ? body[0]?.error : body.error;
    if (err) {
      message = err.message ?? message;
      details = JSON.stringify(err);
    }
  } catch {
    /* plain-text message */
  }
  return { message: String(message).trim(), details };
}

/** Map SDK / auth errors to a clear message naming the missing permission or setting. */
export function explainError(exc, model) {
  if (exc instanceof GeminiUnavailable) return exc;
  const project = config.GOOGLE_CLOUD_PROJECT || "(ADC project)";
  const text = String(exc?.message ?? exc);
  if (/invalid_grant|invalid_rapt|reauth|refresh token/i.test(text) && !(exc instanceof ApiError)) {
    return new GeminiUnavailable(
      "Google Cloud credentials have expired or were revoked. " +
        "Run `gcloud auth application-default login` again and restart the backend.",
    );
  }
  if (/Could not load the default credentials/i.test(text)) return new GeminiUnavailable(NO_CREDENTIALS);
  if (exc instanceof ApiError) {
    const { message: msg, details } = parseApiError(exc);
    const code = exc.status;
    if (code === 401) return new GeminiUnavailable("Google Cloud rejected the credentials (401). Re-run ADC login.");
    if (code === 403) {
      if (details.includes("SERVICE_DISABLED") || msg.includes("has not been used") || msg.includes("is disabled")) {
        return new GeminiUnavailable(
          `The Vertex AI API (aiplatform.googleapis.com) is not enabled for project ${project}. ` +
            `Enable it: gcloud services enable aiplatform.googleapis.com --project ${project}`,
        );
      }
      return new GeminiUnavailable(
        `Permission denied calling ${model} in project ${project}. The identity used by ADC needs ` +
          "the 'Vertex AI User' role (roles/aiplatform.user), which grants " +
          "aiplatform.endpoints.predict. Details: " + msg.slice(0, 300),
      );
    }
    if (code === 404) {
      return new GeminiUnavailable(
        `Model '${model}' was not found at location '${config.GOOGLE_CLOUD_LOCATION}' for project ` +
          `${project}. Check the model ID and GOOGLE_CLOUD_LOCATION. Details: ${msg.slice(0, 300)}`,
      );
    }
    if (code === 429) {
      return new GeminiUnavailable(`Gemini quota exceeded for ${model} (429). Try again shortly or request more quota.`);
    }
    if (code === 400) return new GeminiUnavailable(`Gemini rejected the request for ${model} (400): ${msg.slice(0, 300)}`);
    return new GeminiUnavailable(`Gemini request to ${model} failed (${code}): ${msg.slice(0, 300)}`);
  }
  if (exc?.response?.data?.error || /Could not refresh access token|Unable to authenticate/i.test(text)) {
    return new GeminiUnavailable(`Google Cloud authentication failed: ${text}`);
  }
  const detail = String(exc?.cause?.code || exc?.message || "").slice(0, 150);
  return new GeminiUnavailable(`Gemini request to ${model} failed (${exc?.name ?? typeof exc}${detail ? `: ${detail}` : ""}).`);
}

/** JSON Schema for Gemini's responseJsonSchema (descriptions included, like the Pydantic schemas). */
function jsonSchema(schema) {
  const s = z.toJSONSchema(schema, { target: "draft-2020-12" });
  delete s.$schema;
  return s;
}
const schemaCache = new WeakMap();

/** A named response schema: `{ name, schema }` where schema is a zod object. */
export const defineSchema = (name, schema) => ({ name, schema });

/** The model answered, but not in the requested schema (worth one more attempt). */
class GeminiUnreadable extends GeminiUnavailable {}

const MAX_ATTEMPTS = 3; // first request + one hedge or retry + one more

/**
 * Call the model with a response schema and return the validated object.
 *
 * thinkingLevel ("low" | "medium" | "high") caps how long the model reasons before answering; null
 * uses the model default. timeoutSeconds overrides the client-wide request timeout (timeouts are
 * retried by the client).
 *
 * hedgeSeconds: Gemini latency varies a lot for the same request (19 s vs 127 s vs 813 s measured on
 * one 50 s recording). If no answer has arrived after this many seconds, the same request is sent
 * again and whichever answers first wins; the other is cancelled. A response that does not match the
 * schema is retried once.
 *
 * onText: if given, the first attempt is streamed and onText(textSoFar) is called as Gemini writes,
 * so callers can show partial results early. Hedge and retry attempts are normal requests.
 */
export async function generateJson(
  contents,
  { name, schema },
  { model = null, temperature = 0.2, thinkingLevel = null, timeoutSeconds = null, hedgeSeconds = null, onText = null } = {},
) {
  model = model || config.settings.GEMINI_TEXT_MODEL;
  if (!schemaCache.has(schema)) schemaCache.set(schema, jsonSchema(schema));
  const client = await getClient().catch((exc) => {
    throw explainError(exc, model);
  });
  const t = perf();

  const attempt = async (abortSignal, streamed) => {
    const params = {
      model,
      contents,
      config: {
        temperature,
        responseMimeType: "application/json",
        responseJsonSchema: schemaCache.get(schema),
        maxOutputTokens: 65536,
        abortSignal,
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel: thinkingLevel.toUpperCase() } } : {}),
        ...(timeoutSeconds ? { httpOptions: { timeout: timeoutSeconds * 1000, retryOptions: RETRY } } : {}),
      },
    };
    let response;
    try {
      if (streamed) {
        let text = "";
        let finishReason = null;
        for await (const chunk of await client.models.generateContentStream(params)) {
          finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
          const piece = chunk.text ?? "";
          if (!piece) continue;
          text += piece;
          if (!abortSignal.aborted) onText(text);
        }
        response = { text, candidates: [{ finishReason }] };
      } else {
        response = await client.models.generateContent(params);
      }
    } catch (exc) {
      if (abortSignal.aborted) throw exc;
      const cause = exc?.cause?.code || exc?.cause?.message;
      logger.warning(`Gemini ${model} (${name}) call failed: ${exc?.message ?? exc}${cause ? ` (cause: ${cause})` : ""}`);
      const explained = explainError(exc, model);
      // Credentials, permissions, unknown model and bad requests will not succeed on a retry.
      explained.permanent = (exc instanceof ApiError && [400, 401, 403, 404].includes(exc.status)) || /credentials/i.test(explained.message);
      throw explained;
    }
    const raw = response.text ?? "";
    const finish = response.candidates?.[0]?.finishReason ?? null;
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      // Only sizes are logged: responses contain the users' conversation content.
      logger.warning(`Unreadable ${model} (${name}) response: finish_reason=${finish}, ${raw.length} chars`);
      throw new GeminiUnreadable(`${model} returned a response that could not be read (finish reason: ${finish}).`);
    }
  };

  return new Promise((resolve, reject) => {
    const controllers = [];
    let inFlight = 0;
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      settled = true;
      clearTimeout(timer);
      controllers.forEach((c) => c.abort());
      fn(value);
    };
    const launch = (why) => {
      const ac = new AbortController();
      controllers.push(ac);
      inFlight += 1;
      if (why) logger.info(`Gemini ${model} (${name}): ${why}, sending attempt ${controllers.length}`);
      attempt(ac.signal, Boolean(onText) && controllers.length === 1).then(
        (value) => {
          if (settled) return;
          logger.info(`Gemini ${model} (${name}) answered in ${(perf() - t).toFixed(1)}s`);
          finish(resolve, value);
        },
        (exc) => {
          inFlight -= 1;
          if (settled) return;
          // Temporary failures (unreadable answer, broken stream, network error) get one more attempt.
          if (!exc.permanent && controllers.length < MAX_ATTEMPTS && inFlight === 0) {
            launch(exc instanceof GeminiUnreadable ? "unreadable response" : "temporary failure");
          } else if (inFlight === 0) {
            finish(reject, exc);
          }
        },
      );
    };
    launch(null);
    if (hedgeSeconds) {
      timer = setTimeout(() => {
        if (!settled && controllers.length < MAX_ATTEMPTS) launch(`no answer after ${hedgeSeconds}s`);
      }, hedgeSeconds * 1000);
    }
  });
}

/** generateJson whose first attempt is streamed: onText(textSoFar) is called as Gemini writes. */
export function streamJson(contents, schemaDef, options = {}) {
  return generateJson(contents, schemaDef, { ...options, onText: options.onText ?? (() => {}) });
}

/** Verify ADC, project, and access to both models with tiny requests. Used by GET /api/ai/status. */
export async function checkConnection() {
  const status = {
    project: config.GOOGLE_CLOUD_PROJECT || null,
    location: config.GOOGLE_CLOUD_LOCATION,
    credentials: { ok: false, type: null, error: null },
    models: {},
  };
  try {
    const { client, projectId, serviceAccount } = await adc.load();
    status.credentials.ok = true;
    status.credentials.type = client?.constructor?.name ?? null;
    status.credentials.service_account = serviceAccount;
    status.project = status.project || projectId;
  } catch (exc) {
    if (!(exc instanceof GeminiUnavailable)) throw exc;
    status.credentials.error = exc.message;
    return status;
  }

  const { wavBytes } = await import("./transcription.js");
  for (const [role, model] of [
    ["text", config.settings.GEMINI_TEXT_MODEL],
    ["transcribe", config.settings.GEMINI_TRANSCRIBE_MODEL],
  ]) {
    const entry = { model, ok: false, error: null };
    try {
      const client = await getClient();
      if (role === "text") {
        const r = await client.models.generateContent({
          model,
          contents: "Reply with the single word: ok",
          config: { maxOutputTokens: 16, temperature: 0 },
        });
        entry.sample = (r.text ?? "").trim().slice(0, 40);
      } else {
        // 0.5 s of silence: proves the model is reachable and authorised.
        await client.models.generateContent({
          model,
          contents: [{ inlineData: { data: wavBytes(new Float32Array(8000)).toString("base64"), mimeType: "audio/wav" } }],
        });
      }
      entry.ok = true;
    } catch (exc) {
      entry.error = explainError(exc, model).message;
    }
    status.models[role] = entry;
  }
  return status;
}

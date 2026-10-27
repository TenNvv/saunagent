import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelCatalog } from "../src/models.js";
import { defaults } from "../src/store.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "saunagent-config-"));
  writeFileSync(
    join(directory, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: "https://file-gateway.example/coder/v1",
          api: "openai-completions",
          models: [
            {
              id: "file-only-model",
              name: "File model",
              contextWindow: 64000,
              maxTokens: 4096,
              compat: {
                supportsDeveloperRole: false,
                supportsStore: false,
                supportsUsageInStreaming: false,
                maxTokensField: "max_tokens",
              },
            },
          ],
        },
      },
    }),
  );
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test(
  "Pi models.json and auth.json drive the actual model, endpoint, credentials, and streaming request",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    const authPath = join(f.directory, "auth.json");
    const original = JSON.stringify({
      openai: { type: "api_key", key: "file-test-key-not-a-real-secret" },
    });
    writeFileSync(authPath, original, { mode: 0o600 });
    try {
      const catalog = new ModelCatalog(defaults, {
        OPENAI_BASE_URL: "https://stale-env.example/v1",
        OPENAI_API_KEY: "stale-env-key",
      });
      await catalog.openFiles(f.directory);
      const choice = catalog.resolve({
        provider: "openai",
        modelId: "file-only-model",
      });
      const model = catalog.models.getModel(choice.provider, choice.modelId)!;
      assert.equal(model.baseUrl, "https://file-gateway.example/coder/v1");
      assert.equal(model.api, "openai-completions");
      assert.equal(model.contextWindow, 64000);
      assert.equal(model.maxTokens, 4096);
      assert.equal(
        (await catalog.models.getAuth(model))?.auth.apiKey,
        "file-test-key-not-a-real-secret",
      );
      assert.equal(
        catalog.redact("Rejected file-test-key-not-a-real-secret"),
        "Rejected [REDACTED]",
      );
      let calls = 0;
      const answer = await catalog.models.completeSimple(
        model,
        {
          messages: [
            { role: "user", content: "test files", timestamp: Date.now() },
          ],
        },
        {
          fetch: async (input, init) => {
            calls++;
            const request = new Request(input, init);
            assert.equal(
              request.url,
              "https://file-gateway.example/coder/v1/chat/completions",
            );
            assert.equal(
              request.headers.get("authorization"),
              "Bearer file-test-key-not-a-real-secret",
            );
            const body = await request.json();
            assert.equal(body.model, "file-only-model");
            assert.equal(body.max_tokens, 4096);
            const frame = (delta: object, finish_reason: string | null) =>
              `data: ${JSON.stringify({ id: "files-test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
            return new Response(
              frame(
                { role: "assistant", content: "file configuration works" },
                null,
              ) +
                frame({}, "stop") +
                "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
      );
      assert.equal(answer.stopReason, "stop", answer.errorMessage);
      assert.equal(calls, 1);
      assert.equal(
        readFileSync(authPath, "utf8"),
        original,
        "reading must not rewrite credentials",
      );
      assert.equal(statSync(authPath).mode & 0o777, 0o600);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "Pi creates auth.json privately and accepts explicit paths to shared files",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    const other = mkdtempSync(join(tmpdir(), "saunagent-shared-"));
    try {
      const authPath = join(other, "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({ openai: { type: "api_key", key: "shared-test-key" } }),
        { mode: 0o600 },
      );
      const catalog = new ModelCatalog(defaults, {});
      await catalog.openFiles(other, {
        modelsPath: join(f.directory, "models.json"),
        authPath,
      });
      assert.equal(
        (await catalog.models.getAuth("openai"))?.auth.apiKey,
        "shared-test-key",
      );
      const emptyCatalog = new ModelCatalog(defaults, {});
      await emptyCatalog.openFiles(f.directory);
      await emptyCatalog.models.getAuth("openai");
      assert.equal(
        statSync(join(f.directory, "auth.json")).mode & 0o777,
        0o600,
      );
    } finally {
      f.cleanup();
      rmSync(other, { recursive: true, force: true });
    }
  },
);

test("malformed credential/config errors do not echo private file contents", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.directory, "auth.json"),
      '{"key":"private-test-value", broken',
    );
    const catalog = new ModelCatalog(defaults, {});
    await assert.rejects(catalog.openFiles(f.directory), (error) => {
      assert.match(String(error), /Invalid JSON credential/);
      assert.doesNotMatch(String(error), /private-test-value/);
      return true;
    });
    await assert.rejects(
      catalog.openFiles(f.directory, {
        modelsPath: join(f.directory, "missing.json"),
      }),
      /not found/,
    );
  } finally {
    f.cleanup();
  }
});

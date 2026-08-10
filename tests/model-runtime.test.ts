import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  copyRegisteredProviders,
  createPluginModelRuntime,
  type RegisteredProviderSource,
  type RegisteredProviderTarget,
} from "../src/model-runtime.js";

const legacyConfig = {
  api: "openai-completions" as const,
  apiKey: "workflow-test-key",
  baseUrl: "https://legacy-provider.test/v1",
};

const nativeProvider: Provider = {
  id: "native-provider",
  name: "Native Provider",
  getModels: () => [],
  stream: () => {
    throw new Error("native provider stream is not used in this test");
  },
  streamSimple: () => {
    throw new Error("native provider simple stream is not used in this test");
  },
};

test("copyRegisteredProviders makes legacy and native registrations available in a child runtime", async () => {
  const hostRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  hostRuntime.registerProvider("legacy-provider", legacyConfig);
  hostRuntime.registerNativeProvider(nativeProvider);
  const childRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });

  copyRegisteredProviders(new ModelRegistry(hostRuntime), childRuntime);

  assert.equal(childRuntime.getRegisteredProviderConfig("legacy-provider")?.baseUrl, legacyConfig.baseUrl);
  assert.equal(childRuntime.getRegisteredNativeProvider(nativeProvider.id), nativeProvider);
  assert.deepEqual(childRuntime.getRegisteredProviderIds(), ["legacy-provider", nativeProvider.id]);
});

test("copyRegisteredProviders copies legacy configs before native providers without duplicates", () => {
  const calls: string[] = [];
  const target: RegisteredProviderTarget = {
    registerProvider: (providerId, config) => {
      assert.equal(config, legacyConfig);
      calls.push(`legacy:${providerId}`);
    },
    registerNativeProvider: (provider) => {
      assert.equal(provider, nativeProvider);
      calls.push(`native:${provider.id}`);
    },
  };
  const source: RegisteredProviderSource = {
    getRegisteredProviderIds: () => ["legacy", "native", "mixed"],
    getRegisteredProviderConfig: (providerId) =>
      providerId === "legacy" || providerId === "mixed" ? legacyConfig : undefined,
    getRegisteredNativeProvider: (providerId) =>
      providerId === "native" || providerId === "mixed" ? nativeProvider : undefined,
  };

  copyRegisteredProviders(source, target);

  assert.deepEqual(calls, ["legacy:legacy", "native:native-provider", "legacy:mixed"]);
});

test("copyRegisteredProviders isolates provider accessor and registration failures", () => {
  const calls: string[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    const target: RegisteredProviderTarget = {
      registerProvider: (providerId) => {
        if (providerId === "legacy-register-failure") throw new Error("legacy registration failed");
        calls.push(`legacy:${providerId}`);
      },
      registerNativeProvider: (provider) => {
        if (provider.id === "native-register-failure") throw new Error("native registration failed");
        calls.push(`native:${provider.id}`);
      },
    };
    const source: RegisteredProviderSource = {
      getRegisteredProviderIds: () => [
        "legacy-access-failure",
        "legacy-register-failure",
        "native-access-failure",
        "native-register-failure",
        "legacy-success",
        "native-success",
      ],
      getRegisteredProviderConfig: (providerId) => {
        if (providerId === "legacy-access-failure") throw new Error("legacy accessor failed");
        return providerId.startsWith("legacy-") ? legacyConfig : undefined;
      },
      getRegisteredNativeProvider: (providerId) => {
        if (providerId === "native-access-failure") throw new Error("native accessor failed");
        if (!providerId.startsWith("native-")) return undefined;
        return { ...nativeProvider, id: providerId };
      },
    };

    copyRegisteredProviders(source, target);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls, ["legacy:legacy-success", "native:native-success"]);
  assert.deepEqual(warnings, [
    '[workflow-orchestrator] failed to copy registered provider "legacy-register-failure" into child runtime: legacy registration failed',
    '[workflow-orchestrator] failed to copy registered provider "native-register-failure" into child runtime: native registration failed',
  ]);
});

test("createPluginModelRuntime enables model network refresh by default and preserves explicit offline use", async () => {
  const calls: Array<Parameters<typeof ModelRuntime.create>[0]> = [];
  const originalCreate = ModelRuntime.create;
  ModelRuntime.create = async (options) => {
    calls.push(options);
    return {} as ModelRuntime;
  };
  try {
    await createPluginModelRuntime({ agentDir: "/tmp/pi-workflow-orchestrator-network-policy" });
    await createPluginModelRuntime({
      agentDir: "/tmp/pi-workflow-orchestrator-network-policy",
      allowModelNetwork: false,
    });
  } finally {
    ModelRuntime.create = originalCreate;
  }

  assert.equal(calls[0]?.allowModelNetwork, true);
  assert.equal(calls[1]?.allowModelNetwork, false);
});

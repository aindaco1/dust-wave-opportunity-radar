import { it } from "vitest";
import { assertConsumerPin } from "@dustwave/test-core/consumer-pin";

it("pins the characterized shared packages and lockfile", () => {
  assertConsumerPin({ root: process.cwd(),
  "expectedCommit": "8609b10348da42f20e51b5a9048e074a3a3ae5e2",
  "packages": {
    "worker-core": "0.15.0",
    "test-core": "0.2.0"
  },
  "lockfiles": [
    {
      "path": "package-lock.json",
      "packages": {
        "shared/dust-wave-platform/packages/test-core": "0.2.0",
        "shared/dust-wave-platform/packages/worker-core": "0.15.0"
      }
    }
  ]

  });
});

import { it } from "vitest";
import { assertConsumerPin } from "@dustwave/test-core/consumer-pin";

it("pins the characterized shared packages and lockfile", () => {
  assertConsumerPin({ root: process.cwd(),
  "expectedCommit": "816da7b52ed346025f5bbe3a7a420e9ad7c4a815",
  "packages": {
    "worker-core": "0.15.0",
    "test-core": "0.3.0"
  },
  "lockfiles": [
    {
      "path": "package-lock.json",
      "packages": {
        "shared/dust-wave-platform/packages/test-core": "0.3.0",
        "shared/dust-wave-platform/packages/worker-core": "0.15.0"
      }
    }
  ]

  });
});

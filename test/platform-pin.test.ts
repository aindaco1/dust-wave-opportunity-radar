import { it } from "vitest";
import { assertConsumerPin } from "@dustwave/test-core/consumer-pin";

it("pins the characterized shared packages and lockfile", () => {
  assertConsumerPin({ root: process.cwd(),
  "expectedCommit": "01630b1a132ab88f0e1972d1985e1a0cf860df76",
  "packages": {
    "worker-core": "0.14.0",
    "test-core": "0.2.0"
  },
  "lockfiles": [
    {
      "path": "package-lock.json",
      "packages": {
        "shared/dust-wave-platform/packages/test-core": "0.2.0",
        "shared/dust-wave-platform/packages/worker-core": "0.14.0"
      }
    }
  ]

  });
});

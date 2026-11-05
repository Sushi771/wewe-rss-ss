CREATE TABLE "Wechat2RssSourceGate" (
  "id" INTEGER NOT NULL PRIMARY KEY CHECK ("id" = 1),
  "state" TEXT NOT NULL CHECK ("state" IN ('idle', 'pending', 'stopped')),
  "token" TEXT,
  "status" INTEGER,
  CHECK (("state" = 'idle' AND "token" IS NULL AND "status" IS NULL)
      OR ("state" = 'pending' AND "token" IS NOT NULL AND "status" IS NULL)
      OR ("state" = 'stopped' AND "token" IS NOT NULL AND "status" IN (401, 403, 429)))
);
INSERT INTO "Wechat2RssSourceGate" ("id", "state", "token", "status") VALUES (1, 'idle', NULL, NULL);

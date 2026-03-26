-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_feeds" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mp_name" TEXT NOT NULL,
    "mp_cover" TEXT NOT NULL,
    "mp_intro" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 1,
    "sync_time" INTEGER NOT NULL DEFAULT 0,
    "update_time" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "has_history" INTEGER DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_feeds" ("created_at", "has_history", "id", "mp_cover", "mp_intro", "mp_name", "status", "sync_time", "update_time", "updated_at") SELECT "created_at", "has_history", "id", "mp_cover", "mp_intro", "mp_name", "status", "sync_time", "update_time", "updated_at" FROM "feeds";
DROP TABLE "feeds";
ALTER TABLE "new_feeds" RENAME TO "feeds";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

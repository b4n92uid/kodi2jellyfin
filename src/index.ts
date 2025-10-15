import "dotenv/config";

import knex from "knex";
import path, { basename } from "path";
import { cleanEnv, str } from "envalid";
import { formatISO9075 } from "date-fns";

const env = cleanEnv(process.env, {
  KODI_MYSQL_HOST: str(),
  KODI_MYSQL_USER: str(),
  KODI_MYSQL_PASS: str(),
  KODI_MYSQL_DATABASE: str(),
  JELLYFIN_SQLITE_PATH: str(),
});

//
// 1. Database connections
//
const kodiDb = knex({
  client: "mysql2",
  connection: {
    host: env.KODI_MYSQL_HOST,
    user: env.KODI_MYSQL_USER,
    password: env.KODI_MYSQL_PASS,
    database: env.KODI_MYSQL_DATABASE,
  },
});

const jellyfinDb = knex({
  client: "sqlite3",
  connection: {
    filename: env.JELLYFIN_SQLITE_PATH,
  },
  useNullAsDefault: true,
});

function formatGUID(guid: Buffer) {
  const guidStr = guid.toString("hex");

  // Ensure the hex string is 32 characters long (128 bits)
  if (guidStr.length !== 32) {
    throw new Error(
      "Hex string must be 32 characters long to represent a UUID."
    );
  }

  // Format the hex string into the standard UUID format
  const uuid = [
    guidStr.substring(0, 8),
    guidStr.substring(8, 12),
    guidStr.substring(12, 16),
    guidStr.substring(16, 20),
    guidStr.substring(20, 32),
  ];

  return uuid.join("-");
}

//
// 2. Main synchronization logic
//
async function main() {
  try {
    console.log("🔗 Connecting to Kodi and Jellyfin databases...");

    // 1️⃣ Fetch watched video files from Kodi
    const watched: {
      strFilename: string;
      lastPlayed: string;
      playCount: number;
    }[] = await kodiDb("files")
      .where("playCount", ">", 0)
      .select("strFilename", "lastPlayed", "playCount");

    console.log(`📦 Found ${watched.length} watched items in Kodi.`);

    // 2️⃣ Insert or update in Jellyfin
    for (const kodiEntry of watched) {
      // Try to find the Jellyfin item by file path
      const jellyItem: { guid: Buffer; UserDataKey: string } = await jellyfinDb(
        "TypedBaseItems"
      )
        .select("guid", "UserDataKey")
        .whereLike("Path", `%${kodiEntry.strFilename}%`)
        .first();

      if (!jellyItem) {
        // console.warn(`⚠️  No Jellyfin match found for: ${item.strFilename}`);
        continue;
      }

      const existing: { playCount: number; lastPlayedDate: string } | null =
        await jellyfinDb("UserDatas")
          .where("key", jellyItem.UserDataKey)
          .first();

      const data = {
        userId: 1,
        isFavorite: 0,
        played: 1,
        playbackPositionTicks: 0,
        playCount: kodiEntry.playCount,
        lastPlayedDate:
          (kodiEntry.lastPlayed || formatISO9075(new Date())) + ".000Z",
      };

      if (existing) {
        await jellyfinDb("UserDatas")
          .where("key", jellyItem.UserDataKey)
          .update({
            ...data,
          });
        console.log(`✅ Watch updated: ${kodiEntry.strFilename}`);
      } else {
        await jellyfinDb("UserDatas").insert({
          key: jellyItem.UserDataKey,
          ...data,
        });
        console.log(`✅ Watch inserted: ${kodiEntry.strFilename}`);
      }
    }

    console.log("🎉 Sync complete!");
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await kodiDb.destroy();
    await jellyfinDb.destroy();
  }
}

main();

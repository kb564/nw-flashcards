import type { EncryptedEnvelope } from "./types";
import { assertEncryptedEnvelope } from "./validation";

const DB_NAME = "nw-flashcards-secure-v1";
const STORE_NAME = "encrypted-vault";
const PRIMARY_KEY = "primary";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("端末内の暗号化保管庫を開けません。"));
    request.onblocked = () => reject(new Error("別画面が保管庫を使用中です。ほかの画面を閉じてください。"));
  });
}

export async function loadVaultEnvelope(): Promise<EncryptedEnvelope | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(PRIMARY_KEY);
      request.onsuccess = () => {
        if (request.result === undefined) return resolve(null);
        try {
          assertEncryptedEnvelope(request.result, "nwvault");
          resolve(request.result);
        } catch {
          reject(new Error("端末内の保管庫が破損しています。バックアップから復元してください。"));
        }
      };
      request.onerror = () => reject(new Error("端末内の保管庫を読み込めません。"));
    });
  } finally {
    database.close();
  }
}

export async function saveVaultEnvelope(envelope: EncryptedEnvelope): Promise<void> {
  assertEncryptedEnvelope(envelope, "nwvault");
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(envelope, PRIMARY_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("端末内への保存に失敗しました。変更は確定していません。"));
      transaction.onabort = () => reject(new Error("端末内への保存が中断されました。変更は確定していません。"));
    });
  } finally {
    database.close();
  }
}

export async function deleteVaultEnvelope(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(PRIMARY_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("端末内データを削除できません。"));
      transaction.onabort = () => reject(new Error("端末内データの削除が中断されました。"));
    });
  } finally {
    database.close();
  }
}

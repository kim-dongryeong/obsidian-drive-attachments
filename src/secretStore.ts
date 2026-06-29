export interface StoredSecret {
  encryptedValue: string | null;
  plainValue: string | null;
  storage: "safeStorage" | "plain";
}

interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface ElectronModule {
  safeStorage?: ElectronSafeStorage;
  remote?: {
    safeStorage?: ElectronSafeStorage;
  };
}

export class SecretStore {
  store(value: string): StoredSecret {
    const safeStorage = this.getSafeStorage();
    if (!safeStorage) {
      return {
        encryptedValue: null,
        plainValue: value,
        storage: "plain",
      };
    }

    return {
      encryptedValue: safeStorage.encryptString(value).toString("base64"),
      plainValue: null,
      storage: "safeStorage",
    };
  }

  read(encryptedValue: string | null, plainValue: string | null): string | null {
    if (encryptedValue) {
      const safeStorage = this.getSafeStorage();
      if (!safeStorage) {
        throw new Error("Stored Google Drive token is encrypted, but Electron safeStorage is unavailable.");
      }

      try {
        return safeStorage.decryptString(Buffer.from(encryptedValue, "base64"));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Stored Google Drive token could not be decrypted. Disconnect and reconnect Google Drive to repair local credentials. ${detail}`);
      }
    }

    return plainValue;
  }

  private getSafeStorage(): ElectronSafeStorage | null {
    try {
      const electron = require("electron") as ElectronModule;
      const safeStorage = electron.safeStorage ?? electron.remote?.safeStorage;
      return safeStorage?.isEncryptionAvailable() ? safeStorage : null;
    } catch {
      return null;
    }
  }
}

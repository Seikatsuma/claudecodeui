import { getConnection } from '@/modules/database/connection.js';

type ScanStateRow = {
  last_scanned_at: string;
};

export const scanStateDb = {
    getLastScannedAt() {
        const db = getConnection();

        const row = db
            .prepare(`SELECT last_scanned_at FROM scan_state WHERE id = 1`)
            .get() as ScanStateRow;

        if (!row) {
            return null; // Before any scan, the row is undefined.
        }

        let lastScannedDate: Date | null = null;
        const lastScannedStr = row.last_scanned_at;

        if (lastScannedStr) {
            // SQLite CURRENT_TIMESTAMP returns UTC in "YYYY-MM-DD HH:MM:SS" format.
            // Replace space with 'T' and append 'Z' to parse reliably in JS across all platforms.
            lastScannedDate = new Date(lastScannedStr.replace(' ', 'T') + 'Z');
        }

        return lastScannedDate;
    },

    updateLastScannedAt(scannedAt: Date = new Date()) {
        const db = getConnection();
        const sqliteTimestamp = scannedAt.toISOString().slice(0, 19).replace('T', ' ');

        db.prepare(`
            INSERT INTO scan_state (id, last_scanned_at)
            VALUES (1, ?)
            ON CONFLICT (id)
            DO UPDATE SET last_scanned_at = excluded.last_scanned_at
        `).run(sqliteTimestamp);
    },

    /**
     * Per-account variants of the two above. The single-row table is global,
     * which silently starves every account but the first one scanned: its
     * boundary moves to "now", and another account's transcripts - all older
     * than that - are then skipped forever as "already scanned". Keyed by the
     * canonical account directory, so a fresh account starts with a null
     * boundary and gets one full scan.
     */
    getLastScannedAtForAccount(accountDir: string): Date | null {
        const db = getConnection();

        const row = db
            .prepare(`SELECT last_scanned_at FROM account_scan_state WHERE account_dir = ?`)
            .get(accountDir) as ScanStateRow | undefined;

        if (!row?.last_scanned_at) {
            return null;
        }

        return new Date(row.last_scanned_at.replace(' ', 'T') + 'Z');
    },

    updateLastScannedAtForAccount(accountDir: string, scannedAt: Date = new Date()) {
        const db = getConnection();
        const sqliteTimestamp = scannedAt.toISOString().slice(0, 19).replace('T', ' ');

        db.prepare(`
            INSERT INTO account_scan_state (account_dir, last_scanned_at)
            VALUES (?, ?)
            ON CONFLICT (account_dir)
            DO UPDATE SET last_scanned_at = excluded.last_scanned_at
        `).run(accountDir, sqliteTimestamp);
    }
};

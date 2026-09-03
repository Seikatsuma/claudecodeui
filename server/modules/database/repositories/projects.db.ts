import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

/**
 * Resolves `scopeRootDir` through any symlinks so the prefix comparison in
 * getProjectPaths / isProjectPathInScope uses the same canonical form that
 * validateWorkspacePath stores via realpath().  Falls back to the original
 * (unresolved) path if the directory does not yet exist on disk — a brand-new
 * user's workspace is created lazily, and a non-existent dir cannot match any
 * stored project path anyway.
 */
function resolveScope(scopeRootDir: string): string {
    try {
        return normalizeProjectPath(realpathSync(scopeRootDir));
    } catch {
        return normalizeProjectPath(scopeRootDir);
    }
}

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    createProjectPath(projectPath: string, customProjectName: string | null = null): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived',
                project: row,
            };
        }

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    getProjectPathById(projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    /**
     * Lists active projects, optionally scoped to one filesystem subtree.
     *
     * `scopeRootDir` is how OPEN_REGISTRATION instances keep one web user's
     * sidebar from listing another user's projects: every project this app
     * creates or discovers lives under that user's own workspace root (see
     * web-user-paths.ts), so filtering `project_path` by that root is
     * equivalent to filtering by owner, without needing a `user_id` column
     * or touching every session/project write path to stamp one. Omitting it
     * (the default - every call site outside OPEN_REGISTRATION) returns every
     * active project exactly as before.
     */
    getProjectPaths(scopeRootDir?: string | null): ProjectRepositoryRow[] {
        const db = getConnection();
        if (scopeRootDir) {
            const normalizedScopeRoot = resolveScope(scopeRootDir);
            return db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived
                FROM projects
                WHERE isArchived = 0
                AND (project_path = ? OR project_path LIKE ? || '/%')
            `).all(normalizedScopeRoot, normalizedScopeRoot) as ProjectRepositoryRow[];
        }
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE isArchived = 0
        `).all() as ProjectRepositoryRow[];
    },

    /**
     * Archived rows are queried separately so archive-focused UIs can present
     * hidden workspaces without reintroducing them into the active sidebar list.
     * See getProjectPaths() above for `scopeRootDir` semantics.
     */
    getArchivedProjectPaths(scopeRootDir?: string | null): ProjectRepositoryRow[] {
        const db = getConnection();
        if (scopeRootDir) {
            const normalizedScopeRoot = resolveScope(scopeRootDir);
            return db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived
                FROM projects
                WHERE isArchived = 1
                AND (project_path = ? OR project_path LIKE ? || '/%')
            `).all(normalizedScopeRoot, normalizedScopeRoot) as ProjectRepositoryRow[];
        }
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE isArchived = 1
        `).all() as ProjectRepositoryRow[];
    },

    /**
     * True when `projectPath` is exactly `scopeRootDir` or nested under it.
     * Used to guard `:projectId`-addressed mutations (rename/star/delete/...)
     * against cross-user access on OPEN_REGISTRATION instances - see
     * projects.routes.ts's `router.param('projectId', ...)` guard.
     */
    isProjectPathInScope(projectPath: string, scopeRootDir: string): boolean {
        const normalizedScopeRoot = resolveScope(scopeRootDir);
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        return normalizedProjectPath === normalizedScopeRoot
            || normalizedProjectPath.startsWith(`${normalizedScopeRoot}${path.sep}`);
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(randomUUID(), normalizedProjectPath, customProjectName);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `).run(customProjectName, projectId);
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `).run(isStarred ? 1 : 0, projectId);
    },

    updateProjectIsArchived(projectPath: string, isArchived: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `).run(isArchived ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ?
        `).run(isArchived ? 1 : 0, projectId);
    },

    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
    },

    deleteProjectById(projectId: string): void {
        const db = getConnection();
        db.prepare(`
            DELETE FROM projects
            WHERE project_id = ?
        `).run(projectId);
    },
};

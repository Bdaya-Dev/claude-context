import * as path from 'path';

/**
 * Bdaya-Dev fork customization: allow a small, explicit set of otherwise-skipped
 * files into the index.
 *
 * Upstream unconditionally skips any path segment starting with '.'
 * (context.ts / synchronizer.ts) and only indexes files whose extension is in
 * the supported list. For a DevOps/IaC repo that drops the CI/build config we
 * most need to search: .gitlab-ci.yml, .github/ workflows, Dockerfile, Makefile.
 */

// Dot-directories we descend into despite the leading-dot skip.
export const INCLUDE_DOTDIRS = new Set<string>(['.github']);

// Dot-files we index despite the leading-dot skip (matched on the final segment).
export const INCLUDE_DOTFILES = new Set<string>(['.gitlab-ci.yml', '.gitlab-ci.yaml']);

/**
 * Returns true when a path that contains a leading-dot segment is still allowed.
 * A dotted segment passes only if it is an allow-listed dot-directory, or it is
 * the final segment and an allow-listed dot-file. Any other dotted segment
 * (.git, .dart_tool, .terraform, .vscode, ...) is rejected, preserving upstream
 * behavior and avoiding the full-tree-descent stalls.
 */
export function isHiddenPathAllowed(relativePath: string): boolean {
    const parts = relativePath.split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.startsWith('.')) continue;
        const isLast = i === parts.length - 1;
        if (INCLUDE_DOTDIRS.has(part)) continue;
        if (isLast && INCLUDE_DOTFILES.has(part)) continue;
        return false;
    }
    return true;
}

/**
 * Extensionless / specially-named files we always index regardless of the
 * supported-extension list (path.extname is '' for bare Dockerfile/Makefile).
 * Also matches Dockerfile.dev / web.Dockerfile style names.
 */
export function isAlwaysIncludedFilename(name: string): boolean {
    if (name === 'Dockerfile' || name === 'Containerfile' || name === 'Makefile') return true;
    if (name.startsWith('Dockerfile.') || name.endsWith('.Dockerfile')) return true;
    return false;
}

## Finding: Path encoding for `{path}` endpoints is unspecified — special characters break URLs
Severity: High
Category: Correctness > Edge cases; Correctness > Specification compliance
Location: `specs/firecrest/features/firecrest-backend.feature` lines 154, 160, 210, 220, 238, 245; `specs/firecrest/api-contracts.md` (FilesystemGateway mapping table); `specs/firecrest-research.md` §Filesystem
Spec reference: F-INV-1 (all HPC operations through FirecREST); `specs/firecrest-research.md` §Filesystem

### Description

Several FirecREST endpoints embed a filesystem path as a URL path segment:
- `GET /filesystem/{system}/path/{path}` (list files)
- `GET /filesystem/{system}/stat/{path}` (stat)
- `PUT /filesystem/{system}/path/{path}` (create directory)

The `FirecRESTFilesystemGateway` (api-contracts.md) maps these endpoints with `path` as a raw string parameter. The feature file shows examples like:

```
GET /filesystem/daint/path//scratch/snx3000/cera_user/data
GET /filesystem/daint/stat//scratch/snx3000/cera_user/data/input.nc
PUT /filesystem/daint/path//scratch/snx3000/cera_user/new_results
```

Note the **double slash** after `/path/` — the path starts with `/` and is appended directly. This is the raw form shown in the feature, but the spec does not state:

1. **Is the path URL-encoded?** A path like `/scratch/user name/data` (with a space) or `/scratch/data?version=2` (with `?`) or `/scratch/results#1` (with `#`) would break the URL if not encoded. URL-encoding `/scratch/user name/data` would produce `/scratch/user%20name/data`, which FirecREST would need to decode. The spec doesn't say whether FirecREST expects encoded or raw paths.

2. **What about paths containing `%`?** If the path contains a literal `%` (e.g., `/scratch/data_50%_done`), URL-encoding produces `%2550` (double-encoding) or `%25` (if done correctly). Without clear encoding rules, this is ambiguous.

3. **What about paths with slashes?** A path like `/scratch/snx3000/user/data` contains slashes. When embedded in `/filesystem/daint/path/{path}`, the result is `/filesystem/daint/path/scratch/snx3000/user/data` (if the leading `/` is stripped) or `/filesystem/daint/path//scratch/snx3000/user/data` (if not). The FirecREST HTTP router needs to distinguish `{path}` from subsequent route segments. If `{path}` is a greedy match (catch-all), this works. If not, `/scratch/snx3000/user/data` would match multiple segments and break routing. The spec doesn't document this.

4. **Empty paths, root paths, relative paths.** What if `path` is `""` (empty), `"/"` (root), or `"data/file.nc"` (relative)? The `FilesystemGateway` interface doesn't specify whether paths must be absolute.

5. **Unicode paths.** HPC filesystems support Unicode filenames. URL-encoding Unicode produces multi-byte percent-encoding. The spec doesn't address this.

### Evidence

1. `specs/firecrest/features/firecrest-backend.feature` line 154: `GET /filesystem/daint/path//scratch/snx3000/cera_user/data` — double slash, raw path.
2. `specs/firecrest/api-contracts.md` (FilesystemGateway mapping): `readDir | GET /filesystem/{system}/path/{path} | Maps FirecREST listing to string[]`. No encoding specified.
3. `specs/firecrest-research.md` §Filesystem: `GET /filesystem/{system_name}/path/{path}` — no encoding guidance.
4. `src/firecrest-adapter/types.ts` lines 97–112: `FirecRESTFilesystemGateway` methods take `path: string` — no encoding validation.
5. `src/dsh-adapter/types.ts` lines 156–165: `FilesystemGateway` methods take `path: string` — under the local backend, paths are passed to the OS directly (no URL encoding). Under FirecREST, the same paths must be URL-encoded, but the gateway interface doesn't indicate this.

### Suggested resolution

1. Document the path encoding contract: specify whether `FirecrestClient` URL-encodes the `{path}` segment (recommended: yes, using `encodeURIComponent` with `/` preserved if FirecREST requires raw slashes, or fully encoded if not).
2. Add a Gherkin scenario: "Given a file '/scratch/user name/data.nc' (with a space in the path), When cera stats the file via FirecREST, Then the path is properly URL-encoded and FirecREST returns 200."
3. Specify whether paths must be absolute (recommended: yes, to match the existing `Location` value object and HPC conventions).
4. Add a test that verifies paths with special characters (` `, `?`, `#`, `%`, Unicode) are handled correctly.

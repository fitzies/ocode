import { loadForgeConfig } from "../config.ts";
import { publishDesktopRelease } from "./desktopUpdateStore.ts";

function usage(): never {
  process.stderr.write(
    "Usage: pnpm --filter @anvil/forge publish:desktop -- --artifact <app.tar.gz> --signature <app.tar.gz.sig> --version <semver> [--target darwin] [--arch aarch64] [--notes <text>]\n",
  );
  process.exit(2);
}

function argumentsFrom(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const argumentsWithoutSeparators = argv.filter((argument) => argument !== "--");
  for (let index = 0; index < argumentsWithoutSeparators.length; index += 2) {
    const flag = argumentsWithoutSeparators[index];
    const value = argumentsWithoutSeparators[index + 1];
    if (!flag?.startsWith("--") || value === undefined) usage();
    values[flag.slice(2)] = value;
  }
  return values;
}

const values = argumentsFrom(process.argv.slice(2));
const artifactPath = values.artifact;
const signaturePath = values.signature;
const version = values.version;
if (!artifactPath || !signaturePath || !version) usage();

try {
  const config = loadForgeConfig();
  const release = publishDesktopRelease(config.desktopUpdateDir, {
    artifactPath,
    signaturePath,
    version,
    target: values.target ?? "darwin",
    arch: values.arch ?? "aarch64",
    notes: values.notes,
  });
  process.stdout.write(`Published ocode desktop ${release.version} for ${release.target}-${release.arch}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

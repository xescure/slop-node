{
  lib,
  stdenv,
  importNpmLock,
  nodejs-slim_24,
  gnumake,
  jq,
  makeBinaryWrapper,
}:

let
  package = lib.importJSON ../package.json;
  packageLock = lib.importJSON ../package-lock.json;

  # Entries that come from a dependency's own npm-shrinkwrap.json carry no
  # "resolved" URL, and npm finds them in the registry by name and version. They
  # are fetched from the same registry path, checked against their integrity.
  registryURL = path: module:
    let
      name = lib.last (lib.splitString "node_modules/" path);
    in
    "https://registry.npmjs.org/${name}/-/${baseNameOf name}-${module.version}.tgz";

  # The lock already lists the tree a package's shrinkwrap pins. Flagged with
  # hasShrinkwrap, npm resolves that tree again by name in the registry, which
  # needs the network; unflagged, it installs the same tree from the lock.
  offlineModule = path: module:
    let
      resolved = if path == "" || module ? resolved then { } else { resolved = registryURL path module; };
    in
    removeAttrs module [ "hasShrinkwrap" ] // resolved;

  offlineLock = packageLock // {
    packages = lib.mapAttrs offlineModule packageLock.packages;
  };

  installRoot = "lib/slop-node";
in
stdenv.mkDerivation {
  pname = "slop-node";
  # The node reports the release it speaks as its version (src/version.ts).
  version = package.dependencies."@keetanetwork/keetanet-client";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../Makefile
      ../tsconfig.json
      ../tsconfig.build.json
      ../src
      ../schema/migrations
      ../schema/explorer
      ../patches
      ../utils/apply-patches
    ];
  };

  npmDeps = importNpmLock {
    inherit package;
    packageLock = offlineLock;
  };

  nativeBuildInputs = [
    nodejs-slim_24
    nodejs-slim_24.npm
    gnumake
    jq
    makeBinaryWrapper
  ];
  strictDeps = true;

  postPatch = ''
    patchShebangs --build utils/apply-patches
  '';

  # The install of the Makefile's node_modules/.done rule, from the lock whose
  # entries name the fetched tarballs. importNpmLock's own hook would also patch
  # shebangs and rebuild, and the tree would no longer match the development one.
  #
  # That lock stays for the prune. The original flags keetanet-client with
  # hasShrinkwrap, and npm would take the entries below it from that package's
  # own npm-shrinkwrap.json instead, which has no integrity for most of them
  # since 0.18.8, and fetch those again.
  configurePhase = ''
    runHook preConfigure

    export HOME=$TMPDIR npm_config_offline=true npm_config_fund=false npm_config_audit=false npm_config_progress=false
    cp --no-preserve=mode $npmDeps/package-lock.json package-lock.json
    npm clean-install --ignore-scripts
    touch node_modules/.done

    runHook postConfigure
  '';

  # make finds the dependencies installed, and applies the patches with
  # utils/apply-patches before it compiles. The compiler, a development package
  # that the install prunes, is the only one run here, and the sandbox has no
  # /usr/bin/env for its shebang.
  buildPhase = ''
    runHook preBuild
    patchShebangs --build node_modules/typescript/bin
    make dist
    runHook postBuild
  '';

  # The Make stamps and npm's hidden lockfile are not part of the runtime, and
  # the lockfile names the store paths of every fetched tarball. Pruning leaves
  # the scope directories of the development packages behind, empty.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --ignore-scripts
    rm node_modules/.done node_modules/.patched node_modules/.package-lock.json
    find node_modules -mindepth 1 -maxdepth 1 -name '@*' -type d -empty -delete

    root=$out/${installRoot}
    mkdir -p "$root/schema"
    cp -r dist "$root/dist"
    rm "$root/dist/.done" "$root/dist/.tsbuildinfo"
    cp -r schema/migrations "$root/schema/migrations"
    cp -r schema/explorer "$root/schema/explorer"
    cp -r node_modules package.json "$root/"

    makeBinaryWrapper ${lib.getExe nodejs-slim_24} "$out/bin/slop-node" \
      --add-flags "$root/dist/main.js"
    makeBinaryWrapper ${lib.getExe nodejs-slim_24} "$out/bin/slop-explorer" \
      --add-flags "$root/dist/explorer/main.js"

    runHook postInstall
  '';

  # The wrapper names Node itself, and the prebuilt addons stay as published.
  dontPatchShebangs = true;
  dontPatchELF = true;
  dontStrip = true;

  passthru = {
    inherit installRoot;
    nodejs = nodejs-slim_24;
  };

  meta = {
    description = "A Keeta network node";
    license = {
      fullName = "Keeta Token Network Community License v1.0";
      url = "https://keeta.com/license.pdf";
      free = false;
    };
    mainProgram = "slop-node";
    platforms = nodejs-slim_24.meta.platforms;
  };
}

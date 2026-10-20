{
  lib,
  dockerTools,
  writeTextDir,
  cacert,
  tzdata,
  tini,
  slop-node,
  name,
  description,
  program,
  cmd ? [ ],
  env,
  port,
  stateDirectory ? null,
  revision ? null,
}:

let
  user = name;
  id = 10001;
  home = if stateDirectory == null then "/var/empty" else stateDirectory;
  executable = "${slop-node}/bin/${program}";

  # The licence names itself on its first line; LICENSE holds the text that an
  # SPDX LicenseRef stands for.
  licenseTitle = lib.trim (lib.removePrefix "# " (lib.head (lib.splitString "\n" (builtins.readFile ../LICENSE))));
  licenseRef = "LicenseRef-" + lib.replaceStrings [ " " "(" ")" ] [ "-" "" "" ] licenseTitle;

  # What the node reports as its version (src/version.ts).
  version = "${slop-node.version}+slop-node";

  accounts = [
    (writeTextDir "etc/passwd" ''
      root:x:0:0:root:/root:/noshell
      ${user}:x:${toString id}:${toString id}:${user}:${home}:/noshell
      nobody:x:65534:65534:nobody:/var/empty:/noshell
    '')
    (writeTextDir "etc/group" ''
      root:x:0:
      ${user}:x:${toString id}:
      nobody:x:65534:
    '')
  ];
in
dockerTools.buildLayeredImage {
  inherit name;

  # The package is reached by its store path, as the entrypoint names it:
  # among the contents, each of its files would be linked into the root.
  contents = [ cacert ] ++ accounts;

  extraCommands = ''
    mkdir -p bin tmp var/lib
    ln -s ${executable} bin/${program}
    rm -r nix-support
    chmod 1777 tmp
    ln -s ${tzdata}/share/zoneinfo etc/zoneinfo
  '';

  # Only fakeroot can give a file an owner other than the build user.
  fakeRootCommands = lib.optionalString (stateDirectory != null) ''
    install -d -m 0700 -o ${toString id} -g ${toString id} .${stateDirectory}
  '';

  config = {
    # A process that is PID 1 receives only the signals it handles. The node
    # removes its handlers after the first signal, so that a second one ends
    # it while it stops, and has none while it starts; tini, as PID 1,
    # passes every signal on to the program, which is then an ordinary process.
    Entrypoint = [
      (lib.getExe tini)
      "--"
      executable
    ];
    # Numeric, since Kubernetes' runAsNonRoot cannot tell that a name is not root.
    User = "${toString id}:${toString id}";
    WorkingDir = if stateDirectory == null then "/" else stateDirectory;
    Env = env ++ [
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "TZ=UTC"
      "TZDIR=/etc/zoneinfo"
    ];
    ExposedPorts."${toString port}/tcp" = { };
    Labels = {
      "org.opencontainers.image.title" = name;
      "org.opencontainers.image.description" = description;
      "org.opencontainers.image.version" = version;
      "org.opencontainers.image.source" = "https://github.com/xescure/slop-node";
      "org.opencontainers.image.licenses" = licenseRef;
    }
    // lib.optionalAttrs (revision != null) {
      "org.opencontainers.image.revision" = revision;
    };
  }
  // lib.optionalAttrs (cmd != [ ]) {
    Cmd = cmd;
  };
}

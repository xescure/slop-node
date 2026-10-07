{
  lib,
  dockerTools,
  writeTextDir,
  cacert,
  tzdata,
  tini,
  slop-node,
  revision ? null,
}:

let
  user = "slop-node";
  id = 10001;
  stateDirectory = "/var/lib/slop-node";

  # The node's own default is any free port on 127.0.0.1, which nothing
  # outside a container reaches; the image listens on every interface, at a
  # port it can declare.
  port = 8080;

  # The licence names itself on its first line; LICENSE holds the text that an
  # SPDX LicenseRef stands for.
  licenseTitle = lib.trim (lib.removePrefix "# " (lib.head (lib.splitString "\n" (builtins.readFile ../LICENSE))));
  licenseRef = "LicenseRef-" + lib.replaceStrings [ " " "(" ")" ] [ "-" "" "" ] licenseTitle;

  # What the node reports as its version (src/version.ts).
  version = "${slop-node.version}+slop-node";

  accounts = [
    (writeTextDir "etc/passwd" ''
      root:x:0:0:root:/root:/noshell
      ${user}:x:${toString id}:${toString id}:slop-node:${stateDirectory}:/noshell
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
  name = "slop-node";

  # The package is reached by its store path, as the entrypoint names it:
  # among the contents, each of its files would be linked into the root.
  contents = [ cacert ] ++ accounts;

  extraCommands = ''
    mkdir -p bin tmp var/lib
    ln -s ${lib.getExe slop-node} bin/slop-node
    rm -r nix-support
    chmod 1777 tmp
    ln -s ${tzdata}/share/zoneinfo etc/zoneinfo
  '';

  # Only fakeroot can give a file an owner other than the build user.
  fakeRootCommands = ''
    install -d -m 0700 -o ${toString id} -g ${toString id} .${stateDirectory}
  '';

  config = {
    # A process that is PID 1 receives only the signals it handles. The node
    # removes its handlers after the first signal, so that a second one ends
    # it while it stops, and has none while it starts; tini, as PID 1,
    # passes every signal on to the node, which is then an ordinary process.
    Entrypoint = [
      (lib.getExe tini)
      "--"
      (lib.getExe slop-node)
    ];
    Cmd = [ "run" ];
    # Numeric, since Kubernetes' runAsNonRoot cannot tell that a name is not root.
    User = "${toString id}:${toString id}";
    WorkingDir = stateDirectory;
    Env = [
      "KEETANET_LOCAL_NODE_LISTEN_IP=0.0.0.0"
      "KEETANET_LOCAL_NODE_LISTEN_PORT=${toString port}"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "TZ=UTC"
      "TZDIR=/etc/zoneinfo"
    ];
    ExposedPorts."${toString port}/tcp" = { };
    Labels = {
      "org.opencontainers.image.title" = "slop-node";
      "org.opencontainers.image.description" = slop-node.meta.description;
      "org.opencontainers.image.version" = version;
      "org.opencontainers.image.source" = "https://github.com/xescure/slop-node";
      "org.opencontainers.image.licenses" = licenseRef;
    }
    // lib.optionalAttrs (revision != null) {
      "org.opencontainers.image.revision" = revision;
    };
  };
}

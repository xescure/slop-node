{
  lib,
  nix2container,
  runCommand,
  writeText,
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

  passwd = writeText "passwd" ''
    root:x:0:0:root:/root:/noshell
    ${user}:x:${toString id}:${toString id}:slop-node:${stateDirectory}:/noshell
    nobody:x:65534:65534:nobody:/var/empty:/noshell
  '';
  group = writeText "group" ''
    root:x:0:
    ${user}:x:${toString id}:
    nobody:x:65534:
  '';

  # The image's root outside /nix/store. The package is reached by its store
  # path, as the entrypoint names it, and /bin/slop-node links to it.
  root = runCommand "slop-node-image-root" { } ''
    mkdir -p $out/bin $out/etc $out/tmp $out$(dirname ${stateDirectory})
    mkdir -m 0700 $out${stateDirectory}
    ln -s ${lib.getExe slop-node} $out/bin/slop-node
    cp ${passwd} $out/etc/passwd
    cp ${group} $out/etc/group
    ln -s ${cacert}/etc/ssl $out/etc/ssl
    ln -s ${tzdata}/share/zoneinfo $out/etc/zoneinfo
  '';
in
nix2container.buildImage {
  name = "ghcr.io/xescure/slop-node";

  # Rarely-changing layers first, so a code change re-pushes only the top one:
  # Node and the C runtime it links (changes with nixpkgs), then tini, the CA
  # certificates and the time zones. The package and the root land in the
  # image's own top layer.
  layers =
    let
      runtime = nix2container.buildLayer { deps = [ slop-node.nodejs ]; };
    in
    [
      runtime
      (nix2container.buildLayer { deps = [ tini cacert tzdata ]; layers = [ runtime ]; })
    ];

  copyToRoot = [ root ];

  # The store keeps every file read-only and its owner root; the layer gives
  # /tmp to everyone and the state directory to the node's user alone.
  perms = [
    { path = root; regex = "/tmp$"; mode = "1777"; }
    {
      path = root;
      regex = "${stateDirectory}$";
      mode = "0700";
      uid = id;
      gid = id;
      uname = user;
      gname = user;
    }
  ];

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

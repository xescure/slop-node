{
  pkgs,
  slop-node,
  image,
  skopeo-nix2container,
}:

let
  inherit (pkgs) lib;

  root = "${slop-node}/${slop-node.installRoot}";

  # The representative seed of src/testing/network.ts and the public key of its
  # trusted-root seed: test keys only.
  testNode = ''
    export KEETANET_LOCAL_NODE_SEED=0b7e3a91c4d85f26e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8
    export KEETANET_INITIAL_TRUSTED_ACCOUNT=keeta_aabyvwulmd2q6qtkkd42b4d63a4xcyckeisuknsvywmmbnkypguljzyla42as5q
    export KEETANET_LOCAL_NODE_NETWORK=local
    export KEETANET_LOCAL_NODE_LISTEN_PORT=0
  '';

  # The node prints its API URL once it serves, so its output is read through a
  # FIFO up to that line, rather than polled. A node that has stopped serving
  # closes the FIFO, which bounds the wait for its exit.
  serveThenStop = ''
    fail() {
      echo "$*" >&2
      cat node.stderr >&2
      exit 1
    }

    serve_then_stop() {
      mkfifo node.stdout
      slop-node run >node.stdout 2>node.stderr &
      node=$!
      exec 3<node.stdout

      api=
      while IFS= read -r -t 60 line <&3; do
        echo "$line"
        case $line in
          'api: '*)
            api=''${line#api: }
            break
            ;;
        esac
      done
      [ -n "$api" ] || fail "the node did not serve"

      version=$(curl --fail --silent --show-error "$api/node/version" | jq --raw-output .node)
      [ "$version" = "${slop-node.version}+slop-node" ] || fail "the node reported the version $version"
      echo "GET $api/node/version: $version"

      kill -TERM "$node"
      timeout 20 cat <&3 >node.stopping || fail "the node did not stop within 20 s of SIGTERM"
      cat node.stopping
      status=0
      wait "$node" || status=$?
      [ "$status" -eq 0 ] || fail "the node exited with $status after SIGTERM"
      grep --quiet --line-regexp 'stopping on SIGTERM' node.stopping || fail "the node did not report stopping on SIGTERM"
    }
  '';

  nodeCheck = name: inputs: script:
    pkgs.runCommand "slop-node-check-${name}" { nativeBuildInputs = [ slop-node ] ++ inputs; } ''
      set -euo pipefail
      ${script}
      touch $out
    '';
in
{
  help = nodeCheck "help" [ ] ''
    slop-node --help >usage
    grep --quiet '^Usage: slop-node <command>$' usage
  '';

  run-memory = nodeCheck "run-memory" [ pkgs.curl pkgs.jq ] ''
    ${testNode}
    ${serveThenStop}
    serve_then_stop
  '';

  # The ledger in Postgres over a Unix socket: the node migrates it from the
  # installed schema/migrations, whose files the recorded digests must match.
  run-postgres = nodeCheck "run-postgres" [ pkgs.curl pkgs.jq pkgs.postgresql_18 ] ''
    ${testNode}
    ${serveThenStop}

    socket=$TMPDIR/postgres
    mkdir "$socket"
    initdb --pgdata="$TMPDIR/data" --username=slop --auth=trust --no-locale --encoding=UTF8 >/dev/null
    pg_ctl --pgdata="$TMPDIR/data" --log="$TMPDIR/postgres.log" --wait \
      --options="-c listen_addresses= -c unix_socket_directories=$socket" start
    createdb --host="$socket" --username=slop ledger
    export KEETANET_LOCAL_NODE_POSTGRES_URL="postgresql://slop@''${socket//\//%2F}/ledger"

    serve_then_stop

    for migration in ${root}/schema/migrations/*.sql; do
      name=$(basename "$migration")
      digest=$(sha256sum <"$migration")
      echo "$((10#''${name%%_*})) ''${digest%% *}"
    done >expected
    psql --host="$socket" --username=slop --dbname=ledger --no-align --tuples-only \
      --command="SELECT version || ' ' || encode(sha256, 'hex') FROM schema_version ORDER BY version" >applied
    pg_ctl --pgdata="$TMPDIR/data" --wait stop
    echo "schema_version:"
    cat applied
    [ -s expected ] || fail "no migrations installed in ${root}/schema/migrations"
    cmp expected applied
  '';

  # Everything the package needs at runtime beyond itself is Node's.
  closure = pkgs.runCommand "slop-node-check-closure" {
    package = pkgs.closureInfo { rootPaths = [ slop-node ]; };
    nodejs = pkgs.closureInfo { rootPaths = [ slop-node.nodejs ]; };
  } ''
    comm -23 $package/store-paths $nodejs/store-paths >extra
    echo ${slop-node} | cmp - extra
    touch $out
  '';

  # The image as a runtime would see it: its configuration, its layers unpacked
  # in order into one root, and its entrypoint run from that root alone, as the
  # image's user and as PID 1, with the image's environment. The layers are the
  # ones a push uploads: nix2container's skopeo writes them from the store, as
  # copyTo does, into an OCI layout.
  image =
    let
      package = lib.importJSON ../package.json;
      expected = {
        Entrypoint = [
          (lib.getExe pkgs.tini)
          "--"
          (lib.getExe slop-node)
        ];
        Cmd = [ "run" ];
        User = "10001:10001";
        WorkingDir = "/var/lib/slop-node";
        ExposedPorts."8080/tcp" = { };
        Env = [
          "KEETANET_LOCAL_NODE_LISTEN_IP=0.0.0.0"
          "KEETANET_LOCAL_NODE_LISTEN_PORT=8080"
          "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
          "TZ=UTC"
          "TZDIR=/etc/zoneinfo"
        ];
        Labels = {
          "org.opencontainers.image.title" = "slop-node";
          "org.opencontainers.image.version" = "${slop-node.version}+slop-node";
          "org.opencontainers.image.source" = "https://github.com/xescure/slop-node";
          "org.opencontainers.image.licenses" = "LicenseRef-Keeta-Token-Network-Community-License-v1.0";
        };
      };
      devDependencies = lib.concatStringsSep " " (lib.attrNames package.devDependencies);
    in
    nodeCheck "image" [ pkgs.bubblewrap pkgs.curl pkgs.jq skopeo-nix2container ] ''
      fail() {
        echo "$*" >&2
        [ -e node.stderr ] && cat node.stderr >&2
        exit 1
      }

      skopeo --insecure-policy --tmpdir "$TMPDIR" copy --quiet nix:${image} oci:image:latest
      blob() {
        echo "image/blobs/''${1/://}"
      }
      manifest=$(blob "$(jq --raw-output '.manifests[0].digest' image/index.json)")
      config=$(blob "$(jq --raw-output '.config.digest' "$manifest")")

      echo "config:"
      jq --sort-keys .config "$config"
      jq --exit-status --argjson expected ${lib.escapeShellArg (builtins.toJSON expected)} '
        .config as $config
        | ($expected | del(.Labels) | to_entries | all(.value == $config[.key]))
          and ($expected.Labels | to_entries | all(.value == $config.Labels[.key]))
      ' "$config" >/dev/null || fail "the image's configuration is not the expected one"

      # The store's directories are read-only, and a later layer adds to them.
      mkdir root
      layers=$(jq --raw-output '.layers[].digest' "$manifest")
      for layer in $layers; do
        tar --extract --file="$(blob "$layer")" --directory=root --no-same-owner
        chmod -R u+w root
      done
      echo "layers: $(echo "$layers" | wc -l), unpacked: $(du --summarize --human-readable root | cut -f1)"

      # A path as it resolves in the image, whose links name its own store.
      inside() {
        local target=$1
        while [ -L "root$target" ]; do
          target=$(readlink "root$target")
        done
        echo "root$target"
      }
      passwd=$(inside /etc/passwd)
      group=$(inside /etc/group)

      # Owners and modes survive only in the layers themselves, since unpacking
      # takes the build user's.
      listing=$(for layer in $layers; do tar --list --verbose --numeric-owner --file="$(blob "$layer")"; done)
      grep --quiet --extended-regexp '^drwx------ 10001/10001 .* (\./)?/?var/lib/slop-node/?$' <<<"$listing" \
        || fail "/var/lib/slop-node is not the node user's own"
      grep --quiet --extended-regexp '^drwxrwxrwt 0/0 .* (\./)?/?tmp/?$' <<<"$listing" \
        || fail "/tmp is not writable by everyone, with the sticky bit"
      grep --quiet --line-regexp 'slop-node:x:10001:10001:slop-node:/var/lib/slop-node:/noshell' "$passwd" \
        || fail "/etc/passwd has no slop-node user"
      grep --quiet --line-regexp 'slop-node:x:10001:' "$group" || fail "/etc/group has no slop-node group"

      [ -x "$(inside /bin/slop-node)" ] || fail "/bin/slop-node is not in the image"
      [ -x "root${lib.getExe slop-node}" ] || fail "the entrypoint is not in the image"
      grep --quiet 'BEGIN CERTIFICATE' "$(inside /etc/ssl/certs/ca-bundle.crt)" || fail "the CA bundle is not in the image"
      [ -e "$(inside /etc/zoneinfo)/UTC" ] || fail "the time zones are not in the image"
      diff <(ls ${../schema/migrations}) <(ls "root${root}/schema/migrations") || fail "the migrations in the image differ"

      for name in ${devDependencies}; do
        [ ! -e "root${root}/node_modules/$name" ] || fail "the development package $name is in the image"
      done
      found=$(find root/nix/store -path '*/lib/slop-node/*' \
        \( -name '*.test.*' -o -name testing -o -name suite -o -name conformance -o -name reference -o -name src \) \
        -not -path '*/node_modules/*')
      [ -z "$found" ] || fail "tests or development files are in the image: $found"

      user=$(jq --raw-output '.config.User' "$config")
      uid=''${user%%:*}
      gid=''${user#*:}
      [[ $uid =~ ^[0-9]+$ && $gid =~ ^[0-9]+$ ]] || fail "the image's user $user is not numeric"
      [ "$(awk -F: -v id="$uid" '$3 == id { print $1 }' "$passwd")" = slop-node ] || fail "the image's user $uid is not slop-node"
      [ "$(awk -F: -v id="$gid" '$3 == id { print $1 }' "$group")" = slop-node ] || fail "the image's group $gid is not slop-node"
      mapfile -t command < <(jq --raw-output '.config.Entrypoint[], .config.Cmd[]' "$config")
      environment=()
      while IFS= read -r variable; do
        environment+=(--setenv "''${variable%%=*}" "''${variable#*=}")
      done < <(jq --raw-output '.config.Env[]' "$config")
      port=$(jq --raw-output '.config.ExposedPorts | keys[0] | rtrimstr("/tcp")' "$config")
      workdir=$(jq --raw-output '.config.WorkingDir' "$config")

      # The image listens on every interface, so it must be told where it is
      # reached; everything else it runs with is the image's own. The seeds
      # are the test keys of src/testing/network.ts.
      mkfifo node.stdout
      bwrap --unshare-user --uid "$uid" --gid "$gid" --unshare-pid --as-pid-1 --unshare-ipc --unshare-uts \
        --bind root / --dev /dev --chdir "$workdir" --clearenv "''${environment[@]}" \
        --setenv KEETANET_LOCAL_NODE_SEED 0b7e3a91c4d85f26e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8 \
        --setenv KEETANET_INITIAL_TRUSTED_ACCOUNT keeta_aabyvwulmd2q6qtkkd42b4d63a4xcyckeisuknsvywmmbnkypguljzyla42as5q \
        --setenv KEETANET_LOCAL_NODE_ENDPOINT_API "http://127.0.0.1:$port/api" \
        --setenv KEETANET_LOCAL_NODE_ENDPOINT_P2P "ws://127.0.0.1:$port/p2p" \
        --info-fd 5 \
        -- "''${command[@]}" >node.stdout 2>node.stderr 5>container.json &
      container=$!
      exec 3<node.stdout

      api=
      while IFS= read -r -t 60 line <&3; do
        echo "$line"
        case $line in
          'api: '*)
            api=''${line#api: }
            break
            ;;
        esac
      done
      [ -n "$api" ] || fail "the image's entrypoint did not serve"

      version=$(curl --fail --silent --show-error "$api/node/version" | jq --raw-output .node)
      [ "$version" = "$(jq --raw-output '.config.Labels["org.opencontainers.image.version"]' "$config")" ] \
        || fail "the node reported the version $version, which its image is not labelled with"
      echo "GET $api/node/version: $version"

      # A runtime stops a container by signalling its PID 1 from outside.
      init=$(jq --raw-output '."child-pid"' container.json)
      echo "PID 1: $(tr '\0' ' ' </proc/$init/cmdline)"
      kill -TERM "$init"
      timeout 20 cat <&3 >node.stopping || fail "the image did not stop within 20 s of SIGTERM"
      cat node.stopping
      status=0
      wait "$container" || status=$?
      [ "$status" -eq 0 ] || fail "the image exited with $status after SIGTERM"
      grep --quiet --line-regexp 'stopping on SIGTERM' node.stopping || fail "the node did not report stopping on SIGTERM"
    '';
}

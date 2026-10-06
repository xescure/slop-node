# Every build artifact is defined here; "package.json" only exposes the
# binaries of the npm packages. Run "make help" for a list of targets.

all: dist .nvmrc

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  all           - Builds the project"
	@echo "  dist          - Builds the distribution directory"
	@echo "  test          - Type-checks and runs the test suite"
	@echo "                  Specify extra flags with SLOP_NODE_TEST_EXTRA_ARGS"
	@echo "  do-lint       - Runs the ASCII check, eslint and cspell"
	@echo "  clean         - Removes build artifacts"
	@echo "  distclean     - Removes all build artifacts and dependencies"

# When "clean" or "distclean" is given together with other goals, make would
# otherwise run them concurrently under -j and delete files being built.
CLEAN_GOALS := $(filter clean distclean,$(MAKECMDGOALS))

.nvmrc: package.json Makefile | $(CLEAN_GOALS)
	rm -f .nvmrc .nvmrc.new
	jq -rM '"v" + .engines.node' < package.json > .nvmrc.new
	mv .nvmrc.new .nvmrc

node_modules/.done: package.json package-lock.json | $(CLEAN_GOALS)
	rm -rf node_modules
	npm clean-install --ignore-scripts
	@touch node_modules/.done

# The directory itself is the target here, so it only follows the stamp.
node_modules: node_modules/.done | $(CLEAN_GOALS)
	@touch node_modules

dist/.done: $(shell find src -type f -name '*.ts') tsconfig.json node_modules/.done | $(CLEAN_GOALS)
	npm run tsc
	@touch dist/.done

dist: dist/.done | $(CLEAN_GOALS)
	@touch dist

build/utils/.done: $(shell find utils -type f -name '*.ts' -not -path 'utils/lint-fixtures/*') utils/tsconfig.json tsconfig.json node_modules/.done | $(CLEAN_GOALS)
	npm run tsc -- -p utils
	@touch build/utils/.done

# The type checks share the incremental build info files with the builds,
# so they run after them rather than beside them.
test: dist/.done build/utils/.done
	npm run tsc -- --noEmit
	npm run tsc -- --noEmit -p utils
	npm run vitest -- run --config .vitest.config.js $(SLOP_NODE_TEST_EXTRA_ARGS)

do-lint: node_modules/.done
	@if LC_ALL=C git grep -I -n --untracked '[^[:print:][:space:]]' -- . ':!LICENSE'; then \
		echo "Error: Found non-ASCII characters in the source code." >&2; \
		exit 1; \
	fi
	npm run eslint -- --config .eslint.config.mjs src utils
	npm run cspell -- --config .cspell.config.mjs --no-progress 'src/**/*.ts' 'utils/**/*.ts' Makefile

clean:
	rm -rf dist build .coverage .tsbuildinfo

distclean: clean
	rm -rf node_modules .nvmrc reference

.PHONY: all help test do-lint clean distclean

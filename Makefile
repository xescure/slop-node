# Every build artifact is defined here; "package.json" only exposes the
# binaries of the npm packages. Run "make help" for a list of targets.

CLEAN_GOALS := $(filter clean distclean,$(MAKECMDGOALS))
OTHER_GOALS := $(filter-out clean distclean,$(MAKECMDGOALS))

ifneq ($(and $(CLEAN_GOALS),$(OTHER_GOALS)),)

# Under -j make stats the targets before "clean" has deleted them, so it
# would judge them up to date. Running the clean goals to completion in a
# separate make first gives the rest a fresh view of the tree.
.PHONY: run-mixed-goals $(MAKECMDGOALS)
$(MAKECMDGOALS): run-mixed-goals
	@:

run-mixed-goals:
	$(MAKE) $(CLEAN_GOALS)
	$(MAKE) $(OTHER_GOALS)

else

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

.nvmrc: package.json Makefile
	rm -f .nvmrc .nvmrc.new
	jq -rM '"v" + .engines.node' < package.json > .nvmrc.new
	mv .nvmrc.new .nvmrc

node_modules/.done: package.json package-lock.json
	rm -rf node_modules
	npm clean-install --ignore-scripts
	@touch node_modules/.done

# The directory itself is the target here, so it only follows the stamp.
node_modules: node_modules/.done
	@touch node_modules

dist/.done: $(shell find src -type f -name '*.ts') tsconfig.json node_modules/.done
	npm run tsc
	@touch dist/.done

dist: dist/.done
	@touch dist

build/utils/.done: $(shell find utils -type f -name '*.ts' -not -path 'utils/lint-fixtures/*') utils/tsconfig.json tsconfig.json node_modules/.done
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

endif

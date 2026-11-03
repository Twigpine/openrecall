# The node storage driver (STORE=node) shells out rather than speaking git
# itself: writes go through `git push` over the gitlawb remote helper, which is
# what signs them. So git, gl and git-remote-gitlawb are runtime dependencies of
# that driver, not build tools, and they are absent from a bun-alpine base. A
# driver that discovers that at the first save has already accepted the write.
#
# Pinned by version rather than fetched latest, because openrecall builds none of
# these and the signing helper is the last component that should move without
# someone choosing to move it. npm verifies the integrity of both hops: the
# wrapper's postinstall copies the binaries out of a platform package that
# @gitlawb/gl@<version> pins to that exact version, so the pin reaches the
# binaries and not just the wrapper around them.
#
# node and npm exist only to run that install, so it happens in a stage that is
# thrown away and only the two binaries are copied forward.
FROM oven/bun:1.2-alpine AS glbin
ARG GL_VERSION=0.7.1
RUN apk add --no-cache nodejs npm \
 && npm install -g "@gitlawb/gl@${GL_VERSION}"
# npm links a package's bins before postinstall runs, and this package ships an
# empty bin/ that postinstall fills, so npm silently creates no symlinks. Copy
# from the package directory, not from a bin/ that npm never linked.

FROM oven/bun:1.2-alpine
WORKDIR /app

ARG GL_VERSION=0.7.1
RUN apk add --no-cache git
COPY --from=glbin /usr/local/lib/node_modules/@gitlawb/gl/bin/gl /usr/local/bin/gl
COPY --from=glbin /usr/local/lib/node_modules/@gitlawb/gl/bin/git-remote-gitlawb /usr/local/bin/git-remote-gitlawb
# Assert the pin, not mere presence: a binary that runs but is the wrong version
# is exactly what pinning exists to prevent, and `command -v` cannot see it.
# Runs in the final stage so it checks what ships, not what the builder had.
RUN test "$(gl --version)" = "gl ${GL_VERSION}" \
 && test "$(git-remote-gitlawb --version)" = "git-remote-gitlawb ${GL_VERSION}" \
 && git --version >/dev/null

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY client ./client
COPY skills ./skills
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]

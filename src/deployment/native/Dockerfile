# syntax=docker/dockerfile:1
FROM gcc:14.2.0@sha256:b99b86a28812b1e6453a231a947dc43d76fe192788a12f344a9b568bf9f5d24c AS build
COPY renameNoreplace.c /src/renameNoreplace.c
RUN test "$(gcc -dumpfullversion)" = "14.2.0" \
  && gcc -O2 -static -Wall -Wextra -Werror -o /rename-noreplace /src/renameNoreplace.c \
  && strip /rename-noreplace

FROM scratch
COPY --from=build /rename-noreplace /rename-noreplace

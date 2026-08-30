#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static int component(const char *value) {
  return value[0] && strcmp(value, ".") && strcmp(value, "..") && !strchr(value, '/');
}

int main(int argc, char **argv) {
  if (argc != 4 || !component(argv[2]) || !component(argv[3]) || chdir(argv[1]) != 0) {
    printf("{\"ok\":false,\"error\":\"INVALID\"}\n"); return 64;
  }
#if defined(__linux__) && defined(SYS_renameat2)
  if (syscall(SYS_renameat2, AT_FDCWD, argv[2], AT_FDCWD, argv[3], 1) == 0) {
    printf("{\"ok\":true}\n"); return 0;
  }
  const char *code = errno == EEXIST ? "EEXIST" : errno == EXDEV ? "EXDEV" : errno == ENOSYS ? "ENOSYS" : errno == EOPNOTSUPP ? "EOPNOTSUPP" : "SYSCALL";
  printf("{\"ok\":false,\"error\":\"%s\",\"errno\":%d}\n", code, errno); return 1;
#else
  printf("{\"ok\":false,\"error\":\"ENOSYS\"}\n"); return 1;
#endif
}

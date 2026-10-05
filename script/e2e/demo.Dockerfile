# Image for `make demo-docker`: the Foundry v1.5.1 image plus jq and column, which script/e2e/run.sh uses.
# The repository is mounted at /repo at run time (see the Makefile); nothing from it is baked in.
# The build output, cache and solc directories are world-writable, so the Makefile can run the container as the
# host user on Linux (files in e2e-out/ then belong to that user).
FROM ghcr.io/foundry-rs/foundry:v1.5.1
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq bsdextrautils \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /repo/out /repo/cache /home/foundry/.svm \
 && chown -R foundry:foundry /repo /home/foundry \
 && chmod 1777 /repo/out /repo/cache /home/foundry /home/foundry/.svm
USER foundry
ENV HOME=/home/foundry
WORKDIR /repo
ENTRYPOINT ["script/e2e/demo.sh"]

# syntax=docker/dockerfile:1
#
# Collabora Online with Japanese fonts and Hina Mincho as the preferred
# document default. Local validation image; pin collabora/code for production.
#
FROM collabora/code:latest AS base

FROM debian:bookworm-slim AS fonts

RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-cjk \
      fonts-noto-cjk-extra \
      fonts-ipafont-gothic \
      fonts-ipafont-mincho \
      fontconfig \
    && rm -rf /var/lib/apt/lists/*

COPY fonts/HinaMincho-Regular.ttf /usr/share/fonts/truetype/hinamincho/HinaMincho-Regular.ttf
COPY fonts/OFL.txt /usr/share/fonts/truetype/hinamincho/OFL.txt
COPY 99-japanese-fonts.conf /etc/fonts/conf.d/99-japanese-fonts.conf
RUN fc-cache -f

FROM debian:bookworm-slim AS patcher

RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=base /opt/collaboraoffice/share/registry/main.xcd /tmp/main.xcd
COPY patch-main-xcd.py /tmp/patch-main-xcd.py
RUN python3 /tmp/patch-main-xcd.py /tmp/main.xcd

FROM base

# System fonts for fontconfig/LibreOffice fallback resolution.
COPY --from=fonts /usr/share/fonts /usr/share/fonts
COPY --from=fonts /etc/fonts/conf.d/99-japanese-fonts.conf /etc/fonts/conf.d/99-japanese-fonts.conf
COPY --from=fonts /var/cache/fontconfig /var/cache/fontconfig

# LibreOffice's bundled font directory.
COPY --from=fonts /usr/share/fonts/truetype/hinamincho/HinaMincho-Regular.ttf /opt/collaboraoffice/share/fonts/truetype/HinaMincho-Regular.ttf
COPY --from=fonts /usr/share/fonts/opentype/noto /opt/collaboraoffice/share/fonts/truetype/noto-cjk
COPY --from=fonts /usr/share/fonts/opentype/ipafont-gothic /opt/collaboraoffice/share/fonts/truetype/ipafont-gothic
COPY --from=fonts /usr/share/fonts/opentype/ipafont-mincho /opt/collaboraoffice/share/fonts/truetype/ipafont-mincho

# Collaboration child roots use the systemplate as the font mirror.
COPY --from=fonts /usr/share/fonts /opt/cool/systemplate/usr/share/fonts
COPY --from=fonts /etc/fonts/conf.d/99-japanese-fonts.conf /opt/cool/systemplate/etc/fonts/conf.d/99-japanese-fonts.conf

# Prefer Hina Mincho for LibreOffice's localized text/serif default lists.
COPY --from=patcher /tmp/main.xcd /opt/collaboraoffice/share/registry/main.xcd

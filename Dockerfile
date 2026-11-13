# Manager Server met eigen aanpassingen — Docker-image (linux/amd64).
#
# Bouwen vanuit de map van deze repository:
#   docker build -t manager-server .
# Of gebruik docker-compose.yml (zie AANPASSINGEN.md).
#
# Let op: alleen voor x86-64 (Intel/AMD). Voor PDF's (facturen, e-mail) gebruikt Manager Google Chrome,
# en die bestaat niet voor ARM (zoals een Raspberry Pi).

# ---- Stap 1: Manager bouwen uit de broncode ----
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
# Versienummer van de build; standaard de basisversie + dag en uur van het bouwen.
ARG MANAGER_VERSION_PREFIX=26.11.5
ARG MANAGER_VERSION=
ENV DOTNET_EnableWriteXorExecute=0 \
    DOTNET_gcServer=0 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    MSBUILDDISABLENODEREUSE=1
WORKDIR /src
COPY ManagerServer/ManagerServer.csproj ./ManagerServer/
RUN dotnet restore ManagerServer/ManagerServer.csproj --runtime linux-x64
COPY ManagerServer/ ./ManagerServer/
RUN VERSION="${MANAGER_VERSION:-${MANAGER_VERSION_PREFIX}.$(date +%j%H)}" \
    && dotnet publish ManagerServer/ManagerServer.csproj \
         --configuration Release --runtime linux-x64 --self-contained true \
         -p:UseSharedCompilation=false -maxcpucount:1 --output /out \
         -p:Version=$VERSION \
    && chmod +x /out/ManagerServer

# ---- Stap 2: runtime met Chrome (voor PDF's) ----
FROM mcr.microsoft.com/dotnet/runtime-deps:10.0
# Sommige mailservers gebruiken nog oudere TLS-instellingen
RUN sed -i "s|DEFAULT@SECLEVEL=2|DEFAULT@SECLEVEL=1|g" /etc/ssl/openssl.cnf
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
# Chrome vraagt om systemd, dat in een container niet bestaat: een lege plaatsvervanger
RUN mkdir -p /tmp/fake-systemd/DEBIAN \
    && printf 'Package: systemd\nVersion: 999\nArchitecture: all\nMaintainer: local\nDescription: placeholder (no systemd in container)\n' > /tmp/fake-systemd/DEBIAN/control \
    && dpkg-deb --build /tmp/fake-systemd /tmp/fake-systemd.deb \
    && dpkg -i /tmp/fake-systemd.deb && apt-mark hold systemd && rm -rf /tmp/fake-systemd /tmp/fake-systemd.deb
RUN curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && (apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-dejavu-core fonts-liberation || true) \
    && sed -i 's/exit 1)/true)/' /var/lib/dpkg/info/fontconfig.postinst \
    && dpkg --configure -a \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-dejavu-core fonts-liberation \
    && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/* \
    && google-chrome --version
COPY --from=build /out /opt/manager-server
ENV DOTNET_GCServer=0
ENV ASPNETCORE_URLS=http://*:8080
WORKDIR /opt/manager-server
VOLUME /data
EXPOSE 8080
CMD ["./ManagerServer", "--path", "/data"]

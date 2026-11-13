# Manager Server met eigen aanpassingen

Dit is een aangepaste versie van [Manager](https://www.manager.io) (Server-editie), gericht op een
Nederlands klein bedrijf. Administraties blijven uitwisselbaar met de officiële versie: de
aanpassingen gebruiken alleen gewone onderdelen van Manager (eigen velden, bijlagen).

> **Licentie:** Manager valt onder de Functional Source License (FSL-1.1-Apache-2.0), zie
> [LICENSE.md](LICENSE.md). Gebruik voor je eigen bedrijf is toegestaan; een concurrerend commercieel
> product of dienst ervan maken niet. De aanpassingen zijn alleen in het Nederlands.

## Wat zit erin

| Waar | Aanpassing |
|---|---|
| Inkoopfacturen → nieuw | **PDF inlezen**: leverancier, factuurnummer, datum, totalen, btw en IBAN herkennen; met sjablonen ook alle regels; PDF als bijlage |
| Inkoopfacturen | **Betaallijst**: openstaande facturen, IBAN, markeren als betaald, **SEPA-betaalbestand** |
| Verkooporders → bewerken | **Calculatieblok**: inkoopkosten van de order, extra kosten, opslag, winst |
| Verkooporders | **Samenvoegen** van orders (en terugdraaien), **Bestelnummer ontbreekt**, **Contactpersonen**; kolommen **Kosten / Winst** via *Edit columns* |
| Instellingen → Eigen velden | **Overzicht**: gebruik van elk eigen veld, met advies om op te ruimen |
| Bankafschrift importeren | MT940-bestanden met de extensie `.txt` worden herkend; leesbare omschrijvingen |
| E-mail | Invulvelden in e-mailsjablonen, HTML-mail met huisstijl (`<datamap>/email/layout.html`) |
| Rapporten (Nederland) | **Concept btw-aangifte** in de vorm van het aangifteformulier, met afgeronde bedragen |
| Formulieren | Numpad-komma, inklapbare opties, projectvelden verborgen als Projecten uit staat |

### Eigen velden die de aanpassingen verwachten

Maak deze eigen velden aan (Instellingen → Eigen velden) met precies deze namen, voor zover je de
bijbehorende functie gebruikt:

| Veld | Soort | Op | Gebruikt door |
|---|---|---|---|
| Factuurnummer | Tekst | Inkoopfactuur | PDF-import, betaallijst |
| Bankrekening | Tekst | Inkoopfactuur | PDF-import (IBAN-controle), betaallijst |
| Verkooporder | Tekst | Inkoopfactuur-regels | PDF-import, calculatie, kolom Kosten |
| Opmerkingen | Tekst | Inkoopfactuur | betaallijst |
| Factuur betaald | Vinkje | Inkoopfactuur | betaallijst |
| Opmerking | Tekst (alinea) | Verkooporder | samenvoegen |
| Bestelnummer | Tekst | Verkooporder | samenvoegen, Bestelnummer ontbreekt |
| Contactpersoon | Meerdere waarden | Verkooporder | contactpersonen |
| Calculatie | wordt automatisch aangemaakt | Verkooporder | calculatie, samenvoegen |

### Bestanden in de datamap

Naast de administraties bewaart deze versie een paar eigen bestanden in de datamap (`/data` in Docker).
Ze staan niet in de back-up van Manager zelf, wel in een back-up van de hele datamap:

| Bestand | Inhoud |
|---|---|
| `pdf-sjablonen.json` | sjablonen voor de PDF-import en geleerde herkenning van leveranciers |
| `betaallijst.json` | eigen rekening (IBAN) voor het SEPA-bestand |
| `email/layout.html` (+ afbeeldingen) | optionele huisstijl voor e-mails |

## Installeren met Docker

Werkt op x86-64 (Intel/AMD): een Synology-NAS met Docker (Container Manager), een Proxmox-VM of
-container, of een gewone Linux-pc. **Niet** op een Raspberry Pi: PDF's maken gebruikt Google Chrome,
en dat bestaat niet voor ARM.

1. Maak een map, bijvoorbeeld `manager`, en zet daar [docker-compose.yml](docker-compose.yml) in.
2. Start: `docker compose up -d`
3. Open `http://<server>:8085` en maak de eerste gebruiker (beheerder) aan.

Het image `ghcr.io/frankie4001/manager:latest` wordt automatisch gebouwd bij elke wijziging
(zie `.github/workflows/docker-image.yml`). Zelf bouwen uit de broncode kan ook: zet in
`docker-compose.yml` `build: .` aan in plaats van `image:` en voer de opdracht uit vanuit een kopie van
deze repository.

**Bijwerken:** `docker compose pull && docker compose up -d`. Je gegevens in `./data` blijven staan.

### Proxmox

- Maak een VM (bijv. Debian 12, 2 cores, 2–4 GB geheugen) of een LXC-container met *nesting* aan,
  installeer Docker en volg de stappen hierboven.
- Maak vóór elke update een **snapshot**; gaat er iets mis, zet je dat terug.
- Zet de map `data` op opslag met een back-up (bijv. een NFS-share van een NAS, of Proxmox Backup).

### Toegang van buitenaf

Zet Manager achter een reverse proxy met HTTPS (bijv. die van de Synology, Nginx Proxy Manager of
Caddy), of gebruik een VPN zoals Tailscale. Geef anderen (bijv. een boekhouder) een eigen gebruiker
met de juiste rechten (Users).

## Back-up en uitwisselen

- Een back-up uit deze versie kan in de officiële Manager worden geopend (als die even nieuw of
  nieuwer is). Andersom ook, zolang de officiële versie niet nieuwer is dan deze.
- Maak naast de back-up in Manager ook een back-up van de hele datamap (voor de bestanden hierboven).

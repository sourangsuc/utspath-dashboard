# UTSP Netatmo and NbS dashboard

Public static snapshot of the UTSP city-weather and nature-based-solutions
dashboard.

[Open the live dashboard](https://sourangsuc.github.io/utspath-dashboard/).

The Pages workflow publishes `dashboard-site/`. It includes daily station
summaries, city boundaries, and available NbS layers. It does not include raw
archives, the local SQLite index, or the Python API server. Map-time selection
and live refresh are unavailable; station history plots use daily aggregates.

The published snapshot includes public station identifiers, coordinates, and
weather/NbS data. Its export date is shown in the dashboard. The browser loads
Leaflet, Plotly, and map tiles from public providers.

# Gas & Vibration Monitor - Raspberry Pi 5 + Flask
Activity No. 4: Interfacing Gas and Vibration Sensor with Website

MQ-2 gas sensor (through an ADS1115 ADC) + SW-420 vibration sensor + LED + buzzer,
a live web dashboard, email alerts (smtplib) and a logged history page.

## 1. Enable SPI (needed for the ADC)
    sudo raspi-config     ->  Interface Options  ->  SPI  ->  Yes   (then reboot)
    ls /dev/spidev0.*     ->  should list /dev/spidev0.0

## 2. Install (Raspberry Pi OS Bookworm, Pi 5)
    sudo apt update
    sudo apt install -y python3-gpiozero python3-lgpio python3-spidev python3-venv
    cd gas_vibration_monitor
    python3 -m venv --system-site-packages venv
    source venv/bin/activate
    pip install -r requirements.txt
`--system-site-packages` is important: it lets the venv see the apt-installed GPIO libraries.
Do NOT use `RPi.GPIO`; it does not work on the Pi 5. This project uses gpiozero + lgpio.

## 3. Run
    python app.py
Open `http://<pi-ip>:5000` on a laptop/phone on the same Wi-Fi (`hostname -I` shows the IP).
In VS Code (Remote-SSH to the Pi) you can also press F5 (Run Gas & Vibration Monitor).
Stop with Ctrl+C. Do not run two copies at once (the second cannot claim the GPIO pins).

Test on a normal PC first: it switches to SIMULATION mode automatically
(or set `SIMULATE = True` in config.py) and shows test buttons.

## 4. Wiring (BCM GPIO numbers; physical pin in brackets)
MCP3008 (16 pins, notch up, pin 1 at top-left):
| MCP3008 pin | Connect to |
|---|---|
| VDD (16), VREF (15) | Pi 3.3V (pin 1) |
| AGND (14), DGND (9) | Pi GND (pin 6) |
| CLK (13) | GPIO11 SCLK (pin 23) |
| DOUT (12) | GPIO9 MISO (pin 21) |
| DIN (11) | GPIO10 MOSI (pin 19) |
| CS/SHDN (10) | GPIO8 CE0 (pin 24) |
| CH0 (1) | MQ-2 AO **through the divider below** |

MQ-2 module: VCC -> Pi 5V (pin 2), GND -> GND.
AO -> 10k resistor -> junction (goes to MCP3008 CH0) -> two 10k resistors in series (20k) -> GND.
(The divider drops the 5 V sensor output to 3.3 V so the ADC is not damaged. It matches ADC_DIVIDER_RATIO = 1.5.)

SW-420: VCC -> 3.3V, GND -> GND, DO -> GPIO27 (pin 13).
LED: GPIO17 (pin 11) -> 330 ohm -> LED long leg; short leg -> GND.
Buzzer (active type): + -> GPIO22 (pin 15), - -> GND.
(A small active buzzer is fine on a GPIO pin. For a large/loud buzzer use a transistor.)

## 5. Email alerts
1. Google Account -> Security -> 2-Step Verification -> App passwords -> create one.
2. In config.py set `EMAIL_ENABLED = True`, `SMTP_USER`, `EMAIL_TO`.
3. Before running:  `export SMTP_PASSWORD="your app password"`
4. Press "Send test email" on the dashboard. One alert email is sent per `EMAIL_COOLDOWN` (5 min).

## 6. Pages
- `/` dashboard   - `/history` logs, chart, alert log, CSV download
- `/data` live JSON   - `/control` (POST) button commands

Data is stored in `data/sensor.db` (SQLite). Delete the `data` folder to start fresh.

## Troubleshooting
| Symptom | Fix |
|---|---|
| "Gas sensor error ... spidev" or no reading | Enable SPI, check wiring, `ls /dev/spidev0.0` |
| Gas value always 0 or 1023 | Check the CH0 wire and the divider, VREF and VDD on 3.3V |
| Vibration always on/off | Turn the SW-420 blue potentiometer; if inverted set `VIB_ACTIVE_HIGH = False` |
| `ModuleNotFoundError: gpiozero/lgpio` | Recreate venv with `--system-site-packages` |
| "GPIO busy" | Another copy of app.py is still running: `pkill -f app.py` |
| Page does not open from PC | Same network? Use the Pi IP, port 5000, `http://` not https |
| Email failed | Use an App Password; check EMAIL_ENABLED, SMTP_USER, internet |
| MQ-2 reads high at first | Normal. It needs a warm-up (allow several minutes for stable readings) |

## ADS1115 + FastAPI (replaces the MCP3008 and the ESP32)  <!-- ads1115-patch -->
The server is FastAPI (uvicorn); `python app.py` starts it. The MQ-2 is read by an **ADS1115** (16-bit I2C ADC) that sits
directly on the Pi: MQ-2 -> ADS1115 -> Raspberry Pi 5. Sections 1 and the MCP3008 rows of section 4 above no longer apply
(SPI is not needed). The ESP32 sketch (mq2_esp32/) and the /api/esp32 endpoint are no longer used.

    sudo raspi-config                 ->  Interface Options  ->  I2C  ->  Yes   (then reboot)
    sudo apt install -y i2c-tools
    sudo i2cdetect -y 1               ->  should show  48
    pip install -r requirements.txt   # fastapi, uvicorn, jinja2, smbus2
    python app.py

ADS1115 wiring (the module is powered from **3.3 V** so the I2C lines are 3.3 V; the Pi pins are not 5 V tolerant):
| ADS1115 pin | Connect to |
|---|---|
| VDD | Pi 3.3V (pin 1) |
| GND | Pi GND (pin 6) |
| SCL | GPIO3 / SCL (pin 5) |
| SDA | GPIO2 / SDA (pin 3) |
| ADDR | GND (I2C address 0x48) |
| A0 | MQ-2 AO **through the divider below** |
| ALRT | not connected |

MQ-2 module: VCC -> Pi 5V (pin 2), GND -> Pi GND (common with the ADS1115).
AO -> 10k resistor -> junction (goes to ADS1115 A0) -> two 10k resistors in series (20k) -> GND.
Keep the divider: the MQ-2 outputs up to 5 V, and the ADS1115 input must not exceed VDD + 0.3 V (3.6 V).
The Pi software maps 0-3.3 V at A0 to the dashboard's 0-1023 scale, so the alarm threshold keeps its old meaning.

Clean-air baseline: warm the MQ-2 up for a few minutes in clean air, then press **Calibrate** on the Live page
(30 s, saved to data/calibration.json). Settings: ADS_* in config.py.

| Symptom | Fix |
|---|---|
| `i2cdetect` shows no 48 | I2C not enabled, SDA/SCL swapped, no 3.3 V, or ADDR not on GND |
| "Gas sensor error ... smbus2" | `pip install smbus2` (in the same venv) |
| "... mV on A0 is too high" | Divider missing/wrong, or ADS1115 not powered from 3.3 V |
| Gas value stuck at 0 | A0 wire or MQ-2 power; check ADS_CHANNEL |

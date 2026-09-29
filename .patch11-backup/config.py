"""
Edit this file to match YOUR wiring and email account.
All pin numbers are BCM (GPIO) numbers, not physical pin numbers.
"""
import os

# ---------------- Mode ----------------
# True  = fake sensor data (test the website on any PC, no hardware needed)
# False = real sensors. If the program is not running on a Raspberry Pi it
#         switches to simulation automatically and shows a banner.
SIMULATE = False

# ---------------- Pins (BCM) ----------------
VIB_PIN = 27            # SW-420 DO pin
LED_PIN = 17            # LED (through 330 ohm resistor)
BUZZER_PIN = 22         # Active buzzer (+)
VIB_ACTIVE_HIGH = True  # Book: DO is HIGH when vibration is detected.
                        # If your module is reversed (LOW on vibration) set False.

# ---------------- MQ-2 gas sensor via MCP3008 ADC (SPI0) ----------------
# MCP3008: CLK->GPIO11, DOUT->GPIO9, DIN->GPIO10, CS->GPIO8 (CE0)
GAS_ADC_CHANNEL = 0     # MQ-2 AO goes to MCP3008 CH0
SPI_DEVICE = 0          # 0 = CE0 (GPIO8), 1 = CE1 (GPIO7)
# MQ-2 AO can reach 5 V but the MCP3008 runs at 3.3 V. The wiring guide uses a
# voltage divider (10k top + 20k bottom) -> ADC sees 2/3 of the sensor voltage.
# If you do NOT use a divider (not recommended) set this to 1.0.
ADC_DIVIDER_RATIO = 1.5

# ---------------- Alarm logic ----------------
DEFAULT_GAS_THRESHOLD = 400   # 0-1023 ADC counts. Change it on the dashboard.
WARMUP_SECONDS = 120          # gas alarms are ignored while the MQ-2 heats up
VIB_ALARM_HOLD = 60           # a vibration alarm turns off this many seconds after it STARTED (or on Reset alarm)
VIB_RESET_GRACE = 3           # after Reset alarm, vibration is ignored this long (the button press itself shakes the sensor)
VIB_HOLD_SECONDS = 3          # keep "vibration detected" on screen this long
SAMPLE_INTERVAL = 0.5         # seconds between sensor reads
LOG_INTERVAL = 2              # seconds between database log entries
ALERT_MIN_GAP = 10            # min seconds between two logged alerts
GRAPH_POINTS = 7200          # points kept for the live graphs (7200 x 0.5s = 1 hour); the Live page shows 2 min at 1x zoom and scrolls back
RETENTION_DAYS = 30           # old log rows are deleted after this many days

# ---------------- Email alerts (smtplib) ----------------
EMAIL_ENABLED = False         # set True after filling in the settings below
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587               # 587 = STARTTLS, 465 = SSL
SMTP_USER = os.environ.get("SMTP_USER", "your_email@gmail.com")
# Use a Gmail APP PASSWORD (Google Account > Security > 2-Step Verification >
# App passwords), never your real password. Best practice: set it as an
# environment variable instead of typing it here:
#     export SMTP_PASSWORD="abcd efgh ijkl mnop"
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
EMAIL_TO = os.environ.get("EMAIL_TO", "receiver@example.com")
EMAIL_COOLDOWN = 300          # at most one alert email every 5 minutes

# ---------------- Web server ----------------
HOST = "0.0.0.0"              # reachable from other devices on the network
PORT = 5000

# ---------------- ESP32 (the MQ-2 is wired to the ESP32, not to the Pi) ----------------
# fastapi-esp32
ESP32_ADC_MAX = 4095          # ESP32 ADC is 12-bit (0-4095). The dashboard rescales it to 0-1023.
ESP32_TIMEOUT = 5             # seconds without a packet before the gas sensor is reported as failed
ESP32_TOKEN = "act4embed"     # must equal API_KEY in the ESP32 sketch ("" turns the check off)
# GAS_ADC_CHANNEL / SPI_DEVICE above are no longer used (there is no MCP3008 any more).
# ADC_DIVIDER_RATIO is still used for the "Sensor voltage" number: keep the 10k + 20k divider.

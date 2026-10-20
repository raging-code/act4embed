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

# ---------------- MQ-2 gas sensor via ADS1115 ADC (I2C)  (ads1115-patch) ----------------
# ADS1115: VDD->3.3V, GND->GND, SCL->GPIO3 (pin 5), SDA->GPIO2 (pin 3), ADDR->GND (address 0x48),
# A0 -> MQ-2 AO through the 10k/20k divider. Enable I2C: sudo raspi-config -> Interface Options -> I2C.
ADS_I2C_BUS = 1               # /dev/i2c-1 (the Pi header pins 3 and 5)
ADS_ADDRESS = 0x48            # ADDR->GND 0x48, ->VDD 0x49, ->SDA 0x4A, ->SCL 0x4B
ADS_CHANNEL = 0               # MQ-2 is on A0 (0-3)
ADS_OVERSAMPLE = 8            # conversions averaged per reading (128 SPS, about 70 ms in total)
# The ADS1115 runs at +-4.096 V (0.125 mV per count). The dashboard keeps its old 0-1023 scale:
# 0 mV at the ADS1115 pin = 0, ADC_FULLSCALE_MV at the pin = 1023.
ADC_FULLSCALE_MV = 3300
# MQ-2 AO can reach 5 V but the ADS1115 is powered from 3.3 V (its inputs must stay below VDD + 0.3 V).
# The wiring guide uses a voltage divider (10k top + 20k bottom) -> the ADS1115 sees 2/3 of the sensor voltage.
# If you do NOT use a divider (not recommended) set this to 1.0.
ADC_DIVIDER_RATIO = 2.0       # 20k + 20k divider: the ADS1115 pin sees HALF of AO  (gas-relative-patch)

# ---------------- Alarm logic ----------------
DEFAULT_GAS_THRESHOLD = 150   # 0-1023 ADC counts. Change it on the dashboard.
GAS_RISE_COUNTS = 50          # after Calibrate: alarm when gas is this many counts above the clean-air level
                              # (0 = off, use only the fixed threshold). Raise it if you get false alarms.  (gas-relative-patch)
WARMUP_SECONDS = 120          # gas alarms are ignored while the MQ-2 heats up
VIB_ALARM_HOLD = 60           # a vibration alarm turns off this many seconds after it STARTED (or on Reset alarm)
VIB_RESET_GRACE = 3           # (no longer used since patch11, see VIB_SETTLE_SECONDS)
VIB_SETTLE_SECONDS = 2        # after Reset alarm or the 1-minute timeout, the sensor must be quiet this long before it can alarm again
VIB_QUIET_SECONDS = 5          # the 1-minute countdown only starts once the sensor has been quiet this long;
                                # any new vibration before or during the countdown restarts this wait
GAS_REARM_RATIO = 0.9         # after Reset alarm, gas must fall below this fraction of the threshold...
GAS_REARM_SECONDS = 5         # ...and stay there this many seconds before it can alarm again
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

# ---------------- Clean-air calibration (done on the Pi, "Calibrate" button on the Live page) ----------------
CAL_SECONDS = 30              # how long the clean-air average is recorded

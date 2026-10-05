#!/bin/sh
# Starts an audio server with a null sink on a headless CI runner.
#
# Firefox cannot run an AudioContext without an audio backend: with none reachable the context stays
# "suspended" and its clock never advances (measured on Firefox 155: state suspended, currentTime 0
# after 1.5 s), so every analyser-based probe of the media suite reads silence. Chromium's fake
# devices do not need this.
set -eu
sudo apt-get update
sudo apt-get install -y --no-install-recommends pulseaudio
pulseaudio --daemonize=yes --exit-idle-time=-1
pactl load-module module-null-sink sink_name=ci
pactl set-default-sink ci
pactl info

# GOSAI model training pipeline (multi-model).
#
# Pick the model with MODEL (default: ball). Examples:
#   make all                 # train the ball model
#   make all MODEL=ball      # explicit
#   make train MODEL=foo     # another model under models/foo/
#
# Typical use:
#   export ROBOFLOW_API_KEY=...   (or put it in training/.env)
#   make setup
#   make all
#
# Optional "use my own footage" (never required):
#   (drop clips into models/$(MODEL)/data/custom/videos)
#   make frames
#   make autolabel
#   make all

MODEL ?= ball
RUN := uv run gosai-train --model $(MODEL)

.PHONY: setup models download negatives prepare frames autolabel train export install all clean help

help:
	@echo "Targets: setup | models | download | negatives | prepare | frames | autolabel | train | export | install | all | clean"
	@echo "Select a model with MODEL=<name> (default: ball)."

setup:
	uv sync

models:
	uv run gosai-train models

download:
	$(RUN) download

negatives:
	$(RUN) negatives

prepare:
	$(RUN) prepare

frames:
	$(RUN) frames

autolabel:
	$(RUN) autolabel

train:
	$(RUN) train

export:
	$(RUN) export

install:
	$(RUN) install

all:
	$(RUN) all

clean:
	rm -rf models/$(MODEL)/data/raw models/$(MODEL)/data/merged \
		models/$(MODEL)/data/negatives_pool models/$(MODEL)/runs models/$(MODEL)/exports

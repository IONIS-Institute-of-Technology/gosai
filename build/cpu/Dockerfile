FROM stereolabs/cudagl:12.8.1-base-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_BREAK_SYSTEM_PACKAGES=1
WORKDIR /gosai/

RUN apt-get update && apt-get -y install \
  python3-pip python3-dev \
  libusb-1.0-0-dev libgl1 nano git curl libasound2t64 chromium-browser \
  libgtk-3-0t64 reptyr portaudio19-dev libffi-dev libjpeg-dev \
  libavformat-dev libavcodec-dev libavdevice-dev libavutil-dev \
  libavfilter-dev libswscale-dev libswresample-dev pkg-config && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

RUN apt-get update && \
  apt-get -o Dpkg::Options::="--force-confmiss" install --reinstall -y netbase && \
  apt-get clean && rm -rf /var/lib/apt/lists/*
RUN ln -sf /usr/bin/chromium-browser /usr/bin/chromium
ENV DEVICE=cpu
RUN useradd -m -s /bin/bash gosai

ADD build/cpu/requirements.txt .
RUN pip3 install -r requirements.txt

COPY . .

RUN chmod -R 777 /gosai/
RUN chmod -R 777 "$(python3 -c 'import mediapipe, pathlib; print(pathlib.Path(mediapipe.__file__).parent / "modules")')"

CMD ["su", "gosai", "-s", "/bin/bash", "-c", "python3 init.py"]

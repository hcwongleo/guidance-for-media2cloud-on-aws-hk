# Lambda Python 3.12 layer: PySceneDetect + opencv-python-headless + numpy.
# Built against AWS Lambda's Python 3.12 (x86_64) image so the opencv/numpy
# native wheels match Lambda's manylinux ABI. The --platform pin forces
# x86_64 when this Dockerfile is built on Apple Silicon.

FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.12 AS build

# `dnf install findutils` for the trim step; zip for packaging.
RUN dnf install -y zip findutils

# Install into /opt/python so AWS Lambda's PYTHONPATH picks it up
# automatically when this layer is attached.
RUN mkdir -p /opt/python && \
    pip install --no-cache-dir \
        --target=/opt/python \
        scenedetect==0.6.7.1 \
        opencv-python-headless==4.12.0.88 \
        numpy==2.2.6

# Trim test/cache directories that bloat the layer size.
RUN find /opt/python -type d \( -name __pycache__ -o -name tests -o -name test \) -prune -exec rm -rf {} +

RUN cd /opt && zip -rq /var/task/package.zip python

FROM --platform=linux/amd64 public.ecr.aws/lambda/python:3.12 AS release

COPY --from=build /var/task/package.zip /var/task/package.zip

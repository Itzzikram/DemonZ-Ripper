terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket = "demonz-ripper-terraform-state"
    key    = "infrastructure/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  default = "us-east-1"
}

variable "environment" {
  default = "production"
}

# ── S3 Bucket for Rip Output ──
resource "aws_s3_bucket" "rip_output" {
  bucket = "demonz-ripper-output-${var.environment}"
  tags = {
    Environment = var.environment
    Project     = "demonz-ripper"
  }
}

resource "aws_s3_bucket_public_access_block" "rip_output" {
  bucket = aws_s3_bucket.rip_output.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "rip_output" {
  bucket = aws_s3_bucket.rip_output.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "rip_output" {
  bucket = aws_s3_bucket.rip_output.id

  rule {
    id     = "auto-cleanup"
    status = "Enabled"

    # Auto-delete ripped files after 30 days
    expiration {
      days = 30
    }

    # Expire old versions after 7 days (versioning is enabled)
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "rip_output" {
  bucket = aws_s3_bucket.rip_output.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ── CloudFront CDN (for serving ripped assets) ──
resource "aws_cloudfront_distribution" "cdn" {
  origin {
    domain_name = aws_s3_bucket.rip_output.bucket_regional_domain_name
    origin_id   = "S3-rip-output"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.oai.cloudfront_access_identity_path
    }
  }

  enabled     = true
  price_class = "PriceClass_100"

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-rip-output"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_cloudfront_origin_access_identity" "oai" {
  comment = "DemonZ Ripper CDN OAI"
}

# ── S3 Bucket Policy (grant CloudFront OAI read access) ──
resource "aws_s3_bucket_policy" "rip_output" {
  bucket = aws_s3_bucket.rip_output.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        AWS = aws_cloudfront_origin_access_identity.oai.iam_arn
      }
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.rip_output.arn}/*"
    }]
  })
}

# ── Outputs ──
output "cdn_domain" {
  value = aws_cloudfront_distribution.cdn.domain_name
}

output "s3_bucket" {
  value = aws_s3_bucket.rip_output.id
}

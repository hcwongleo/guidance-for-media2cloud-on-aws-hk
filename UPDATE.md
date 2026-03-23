# Media2Cloud Stack Update Guide

This guide explains how to update your existing Media2Cloud CloudFormation stack with new features or bug fixes while preserving your data.

## Table of Contents

- [Development Workflow](#development-workflow)
- [Building Updates](#building-updates)
- [Updating the Stack](#updating-the-stack)
- [Version Management](#version-management)
- [Troubleshooting](#troubleshooting)

---

## Development Workflow

### 1. Prepare Your Environment

```bash
# Navigate to your project directory
cd /Users/hcwong/Solution/guidance-for-media2cloud-on-aws-hk

# Pull latest changes (if working with a team)
git pull origin main

# Switch to Node.js 20
source ~/.nvm/nvm.sh
nvm use 20
```

### 2. Make Your Code Changes

- Edit source code in `source/` directory
- Test locally when possible
- Update documentation in README or CHANGELOG

### 3. Commit Changes to Git

```bash
git add .
git commit -m "Description of your changes"
git push origin main
```

---

## Building Updates

### Step 1: Build New Version

**Important**: Always increment the version number when updating.

```bash
cd deployment

# Build with new version number
bash build-s3-dist.sh \
  --bucket media2cloud-artefeact-385085470441-us-east-1 \
  --version v4.0.11 \
  --single-region > build.log 2>&1 &

# Monitor build progress
tail -f build.log
```

### Step 2: Deploy to S3

Once the build completes successfully:

```bash
bash deploy-s3-dist.sh \
  --bucket media2cloud-artefeact-385085470441-us-east-1 \
  --version v4.0.11 \
  --single-region
```

You'll receive a template URL like:
```
https://media2cloud-artefeact-385085470441-us-east-1.s3.amazonaws.com/media2cloud/v4.0.11/media2cloud.template
```

---

## Updating the Stack

### Option A: Update via AWS Console (Recommended)

1. **Navigate to CloudFormation Console**
   - Go to: https://console.aws.amazon.com/cloudformation/
   - Region: `us-east-1`

2. **Select Your Stack**
   - Find and select stack: `media2cloudv4`
   - Click **Update** button

3. **Replace Template**
   - Choose: **Replace current template**
   - Amazon S3 URL: Enter your new template URL
   ```
   https://media2cloud-artefeact-385085470441-us-east-1.s3.amazonaws.com/media2cloud/v4.0.11/media2cloud.template
   ```

4. **Keep Existing Parameters**
   - On the parameters page, **do not change any values**
   - This preserves your existing configuration and data
   - Click **Next**

5. **Review and Update**
   - Review the changes summary
   - Acknowledge IAM capabilities if prompted
   - Click **Submit**

6. **Monitor Update Progress**
   - Watch the **Events** tab for progress
   - Update typically takes 10-20 minutes
   - Status should change from `UPDATE_IN_PROGRESS` to `UPDATE_COMPLETE`

### Option B: Update via AWS CLI

```bash
aws cloudformation update-stack \
  --stack-name media2cloudv4 \
  --template-url https://media2cloud-artefeact-385085470441-us-east-1.s3.amazonaws.com/media2cloud/v4.0.11/media2cloud.template \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --parameters \
    ParameterKey=VersionCompatibilityStatement,UsePreviousValue=true \
    ParameterKey=Email,UsePreviousValue=true \
    ParameterKey=DefaultAIOptions,UsePreviousValue=true \
    ParameterKey=PriceClass,UsePreviousValue=true \
    ParameterKey=StartOnObjectCreation,UsePreviousValue=true \
    ParameterKey=UserDefinedIngestBucket,UsePreviousValue=true \
    ParameterKey=OpenSearchCluster,UsePreviousValue=true \
    ParameterKey=EnableKnowledgeGraph,UsePreviousValue=true \
    ParameterKey=CidrBlock,UsePreviousValue=true \
    ParameterKey=BedrockSecondaryRegionAccess,UsePreviousValue=true \
    ParameterKey=BedrockModel,UsePreviousValue=true
```

**Monitor Stack Update:**
```bash
# Watch stack status
aws cloudformation describe-stacks \
  --stack-name media2cloudv4 \
  --query 'Stacks[0].StackStatus' \
  --output text

# Monitor events
aws cloudformation describe-stack-events \
  --stack-name media2cloudv4 \
  --max-items 20
```

---

## Version Management

### Version Numbering Strategy

Use semantic versioning: `vMAJOR.MINOR.PATCH`

| Version Type | When to Use | Example |
|:-------------|:------------|:--------|
| **Patch** | Bug fixes, small improvements, security patches | v4.0.10 → v4.0.11 |
| **Minor** | New features, non-breaking changes, enhancements | v4.0.x → v4.1.0 |
| **Major** | Breaking changes, major redesigns, incompatible updates | v4.x.x → v5.0.0 |

### Current Version

Check your current deployed version:

```bash
aws cloudformation describe-stacks \
  --stack-name media2cloudv4 \
  --query 'Stacks[0].Parameters[?ParameterKey==`Version`].ParameterValue' \
  --output text
```

Or check in the CloudFormation Console under **Parameters** tab.

---

## What Gets Updated vs Preserved

### ✅ Updated Components (No Data Loss)

- Lambda function code
- Lambda layer dependencies
- Step Function state machines
- CloudFormation templates
- API Gateway configurations
- Web application code

### 🔒 Preserved Components (Data Intact)

- **S3 Buckets** - All your uploaded media files
- **DynamoDB Tables** - All metadata and indexes
- **OpenSearch Indices** - All search data
- **CloudFront Distribution** - Same web portal URL
- **Cognito User Pool** - User accounts and credentials
- **Face Collections** - Rekognition face indexes

**Important**: Stack updates modify infrastructure code, **not your data**.

---

## Post-Update Validation

### 1. Check Stack Status

```bash
aws cloudformation describe-stacks \
  --stack-name media2cloudv4 \
  --query 'Stacks[0].StackStatus'
```

Expected: `UPDATE_COMPLETE`

### 2. Verify Lambda Functions

```bash
# List Lambda functions
aws lambda list-functions \
  --query 'Functions[?contains(FunctionName, `so0050`)].FunctionName'

# Check a specific function version
aws lambda get-function \
  --function-name so0050-xxxxx-ingest-main
```

### 3. Test Web Portal

1. Access your CloudFront URL
2. Log in with existing credentials
3. Verify existing demo data is visible
4. Upload a test file to verify new functionality

### 4. Monitor CloudWatch Logs

```bash
# List log groups
aws logs describe-log-groups \
  --log-group-name-prefix /aws/lambda/so0050

# Tail recent logs (replace with actual log group name)
aws logs tail /aws/lambda/so0050-xxxxx-ingest-main --follow
```

---

## Troubleshooting

### Update Failed: Rollback in Progress

**Cause**: Template validation error, resource conflicts, or permission issues

**Solution**:
1. Check CloudFormation Events tab for error details
2. Stack will automatically rollback to previous version
3. Fix the issue and retry update
4. Your data remains safe during rollback

### Lambda Functions Not Updated

**Cause**: Version number wasn't incremented

**Solution**:
```bash
# Force Lambda function update
aws lambda update-function-code \
  --function-name so0050-xxxxx-function-name \
  --s3-bucket media2cloud-artefeact-385085470441-us-east-1 \
  --s3-key media2cloud/v4.0.11/function-package.zip
```

### PDF/Document Processing Still Failing

**Cause**: Lambda layer not updated or cached

**Solution**:
1. Verify pdf-lib layer was rebuilt:
```bash
aws lambda list-layers \
  --query 'Layers[?contains(LayerName, `pdf-lib`)].LatestMatchingVersion'
```

2. Force layer update by incrementing version and rebuilding

### Web Portal Not Showing Changes

**Cause**: CloudFront cache

**Solution**:
```bash
# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/*"
```

---

## Best Practices

### Before Updating

- ✅ **Commit all code changes to Git**
- ✅ **Increment version number**
- ✅ **Test in development environment first** (if available)
- ✅ **Backup critical data** (optional but recommended)
- ✅ **Review CloudFormation change set**
- ✅ **Schedule during low-usage period**

### During Update

- ✅ **Monitor CloudFormation Events tab**
- ✅ **Keep CloudWatch Logs open**
- ✅ **Don't modify stack during update**
- ✅ **Wait for UPDATE_COMPLETE status**

### After Update

- ✅ **Test all critical workflows**
- ✅ **Verify existing data integrity**
- ✅ **Check CloudWatch for errors**
- ✅ **Document any issues encountered**
- ✅ **Update version in documentation**

---

## Quick Reference: Complete Update Workflow

```bash
# 1. Prepare
cd /Users/hcwong/Solution/guidance-for-media2cloud-on-aws-hk
git pull origin main
source ~/.nvm/nvm.sh && nvm use 20

# 2. Make changes (edit code)

# 3. Commit
git add .
git commit -m "Your changes"
git push origin main

# 4. Build
cd deployment
bash build-s3-dist.sh \
  --bucket media2cloud-artefeact-385085470441-us-east-1 \
  --version v4.0.11 \
  --single-region

# 5. Deploy to S3
bash deploy-s3-dist.sh \
  --bucket media2cloud-artefeact-385085470441-us-east-1 \
  --version v4.0.11 \
  --single-region

# 6. Update Stack (via Console or CLI)
# Console: Use the template URL from deploy output
# CLI: Use the command in "Option B" section above

# 7. Validate
aws cloudformation describe-stacks --stack-name media2cloudv4
```

---

## Support

For issues or questions:
- Check CloudFormation Events tab for error details
- Review CloudWatch Logs for Lambda errors
- Consult the [main README](./README.md) for build instructions
- Refer to [AWS Documentation](https://aws.amazon.com/cloudformation/)

## Applying the PDF Library Fix

To apply the current PDF library fix (v4.0.11):

```bash
cd /Users/hcwong/Solution/guidance-for-media2cloud-on-aws-hk/deployment

# Build v4.0.11 with PDF fix
bash build-s3-dist.sh \
  --bucket media2cloud-artefeact-385085470441-us-east-1 \
  --version v4.0.11 \
  --single-region

# Deploy to S3
bash deploy-s3-dist.sh \
  --bucket media2cloud-artefeact-385085470441-us-east-1 \
  --version v4.0.11 \
  --single-region

# Update stack via Console with new template URL
```

Your demo data will remain intact during the update.

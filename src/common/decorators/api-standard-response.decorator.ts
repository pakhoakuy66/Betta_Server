import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  ApiErrorResponseDto,
  ApiSuccessResponseDto,
} from '../dto/api-response.dto';

export const ApiStandardSuccess = () =>
  ApiOkResponse({
    type: ApiSuccessResponseDto,
  });

export const ApiStandardErrors = () =>
  applyDecorators(
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
    }),
    ApiUnauthorizedResponse({
      type: ApiErrorResponseDto,
    }),
    ApiTooManyRequestsResponse({
      type: ApiErrorResponseDto,
    }),
    ApiInternalServerErrorResponse({
      type: ApiErrorResponseDto,
    }),
  );

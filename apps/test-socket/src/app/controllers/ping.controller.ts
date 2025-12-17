import { FastifyReply, FastifyRequest } from 'fastify';
import { Controller, Post, Req, Res } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { PingService } from '../services/ping.service';

export interface PingQuery {
  name?: string;
}

@Controller('/ping')
export class PingController {
  constructor(private readonly service: PingService = new PingService()) {}

  @Post()
  @ApiOperation({ summary: 'Ping Endpunkt' })
  async ping(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const { name } = (request.query as PingQuery | undefined) ?? {};
    const response = this.service.ping(name);
    return reply.send(response);
  }
}

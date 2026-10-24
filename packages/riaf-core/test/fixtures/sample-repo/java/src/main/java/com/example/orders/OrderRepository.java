package com.example.orders;

import java.util.ArrayList;
import java.util.List;

public class OrderRepository {

    private final List<OrderDto> orders = new ArrayList<>();

    public List<OrderDto> findAll() {
        return orders;
    }

    public OrderDto save(CreateOrderRequest request) {
        OrderDto dto = new OrderDto(request.customerId(), request.amountCents());
        orders.add(dto);
        return dto;
    }
}
